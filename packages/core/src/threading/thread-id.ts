/**
 * Stable thread-id derivation.
 *
 * Two messages belong to the same thread if their normalized
 * `(subject, root-from)` tuple matches. Computing this on demand
 * from envelope data is cheap and avoids depending on the IMAP
 * `THREAD` extension (which Stalwart doesn't advertise) or on
 * reconstructing `In-Reply-To` / `References` chains (which agents
 * sometimes forge or strip).
 *
 * # Normalization rules
 *
 *   - Strip every leading `Re:` / `Fwd:` / `Re[2]:` chain. Some
 *     clients chain prefixes (`Re: Re: Fwd: Re: …`), which would
 *     otherwise produce a different thread id for every hop.
 *   - Collapse internal whitespace to single spaces.
 *   - Trim leading + trailing whitespace.
 *   - Lower-case for case-insensitive matching.
 *   - Reply-on-thread coordination markers (`[FINAL]`, `[DONE]`,
 *     `[CLOSED]`, `[WRAP]`) are stripped — a closing message
 *     belongs to the SAME thread as the conversation it closes.
 *
 * # Identity hash
 *
 * SHA-256 of `<normalizedSubject>\n<rootFromLower>`, base64url
 * truncated to 16 chars (~12 bytes of entropy = ~10^28 distinct
 * threads; collision-free for any realistic deployment).
 *
 * The root sender is included so two unrelated conversations
 * that share a generic subject ("hello", "follow up") aren't
 * collapsed into one thread. We use the FIRST sender's address
 * on the thread — agents reading a reply pass their own
 * envelope's `from` value, but the thread id stays stable
 * because we re-derive `rootFromAddr` from the cache when
 * looking up an existing thread (see thread-cache.ts).
 */

import { createHash } from 'node:crypto';

/** Strip every leading "Re:", "Fwd:", "Fw:", "Re[2]:" etc. */
function stripReplyPrefixes(subject: string): string {
  let s = subject;
  // Repeat until no more prefixes match — handles chained "Re: Fwd: Re: foo"
  for (;;) {
    const next = s.replace(/^\s*(?:re|fwd?|fw)\s*(?:\[\d+\])?\s*:\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Strip thread-close coordination markers — they're not part of the topic. */
function stripCoordinationMarkers(subject: string): string {
  return subject.replace(/\[\s*(?:final|done|closed|wrap)\s*\]/gi, ' ');
}

export function normalizeSubject(subject: string | undefined | null): string {
  if (!subject) return '(no subject)';
  let s = stripReplyPrefixes(subject);
  s = stripCoordinationMarkers(s);
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s || '(no subject)';
}

export function normalizeAddress(addr: string | undefined | null): string {
  if (!addr) return '(unknown)';
  // Strip angle brackets + display name from "Foo <foo@x>".
  const m = addr.match(/<([^>]+)>/);
  const raw = m ? m[1] : addr;
  return raw.trim().toLowerCase();
}

export interface ThreadIdInput {
  subject?: string | null;
  /** Optional. Kept as a field so call sites that previously
   *  passed it keep working, but NOT used in the hash. The thread
   *  id is intentionally subject-only so a reply from a different
   *  sender (the replier, not the root) still maps to the same
   *  thread without needing a cache lookup first. The dispatcher's
   *  legacy `threadIdFromSubject` uses the same convention; this
   *  function is its disk-safe + hashed equivalent. */
  rootFromAddr?: string | null;
}

/**
 * Subject-only stable thread id. Collisions between unrelated
 * conversations that genuinely share the same normalized subject
 * ("hello", "follow up") are accepted as the tradeoff for stable
 * threading across replies. In practice agents on different
 * threads use different participants, so the wake-budget +
 * thread-close logic disambiguates downstream.
 */
export function threadIdFor(input: ThreadIdInput): string {
  const subject = normalizeSubject(input.subject);
  return createHash('sha256')
    .update(subject)
    .digest('base64url')
    .slice(0, 16);
}
