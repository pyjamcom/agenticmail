/**
 * Tests for normalizeWakeList — the function that converts the raw
 * `wake` field shipped from MCP / HTTP into the canonical
 * lowercased bare-name array the dispatcher uses for gating.
 *
 * Regression coverage for the wake-allowlist-is-a-JSON-string bug
 * that quietly excluded every recipient on 0.9.0-0.9.12: Claude
 * sometimes passes `wake: '["orion"]'` (JSON-stringified) instead
 * of `wake: ["orion"]`, and the old CSV-only string path treated
 * the whole blob as a single agent name → dispatcher logged
 * `list=["[\"orion\"]"]` and excluded the real "orion" wake.
 */
import { describe, it, expect } from 'vitest';
import { normalizeWakeList, deriveWakeFromBody } from '../routes/mail.js';

describe('normalizeWakeList', () => {
  it('returns undefined for undefined / null', () => {
    expect(normalizeWakeList(undefined)).toBeUndefined();
    expect(normalizeWakeList(null)).toBeUndefined();
  });

  it('treats "all" and the WAKE_ALL_SENTINEL as opt-out (undefined → no filter)', () => {
    expect(normalizeWakeList('all')).toBeUndefined();
    expect(normalizeWakeList('__wake_all__')).toBeUndefined();
  });

  it('passes a real array through (lowercased, @localhost stripped)', () => {
    expect(normalizeWakeList(['Orion', 'Vesper@localhost'])).toEqual(['orion', 'vesper']);
  });

  it('splits comma-separated strings into bare names', () => {
    expect(normalizeWakeList('orion, vesper, atlas')).toEqual(['orion', 'vesper', 'atlas']);
    expect(normalizeWakeList('orion@localhost,vesper@localhost')).toEqual(['orion', 'vesper']);
  });

  it('parses JSON-stringified arrays — regression for 0.9.13', () => {
    // Claude sometimes serializes the array before calling the MCP tool
    // (model confusion or middleware mishandling). The old behaviour
    // dropped the whole call into the CSV path, producing a one-element
    // list whose single string was `'["orion"]'`. Fix: detect the JSON
    // shape and parse it back into an array.
    expect(normalizeWakeList('["orion"]')).toEqual(['orion']);
    expect(normalizeWakeList('["orion","vesper"]')).toEqual(['orion', 'vesper']);
    // Same with whitespace + @localhost suffixes mixed in.
    expect(normalizeWakeList('  ["Orion@localhost", "Vesper"]  ')).toEqual(['orion', 'vesper']);
    // Empty JSON array means "wake nobody" (canonical "send silently").
    expect(normalizeWakeList('[]')).toEqual([]);
  });

  it('falls back to CSV when the brackets are present but the JSON is bogus', () => {
    // Looks like a JSON array but isn't valid — we don't want a stray
    // `[orion]` to silently fail and produce undefined. Treat as CSV.
    expect(normalizeWakeList('[orion]')).toEqual(['[orion]']);
  });

  it('returns undefined for non-string non-array inputs', () => {
    expect(normalizeWakeList(42)).toBeUndefined();
    expect(normalizeWakeList(true)).toBeUndefined();
    expect(normalizeWakeList({ name: 'orion' })).toBeUndefined();
  });
});

/**
 * Tests for deriveWakeFromBody — the body parser that unbreaks
 * reply-all coordination chains where the original sender stays on
 * To: but the body redirects the next slice to a CC'd participant.
 *
 * Regression scenario that drove this:
 *
 *   Kepler replies-all to a thread sable started. reply_email auto-
 *   fills To: sable (original sender). Body opens with
 *   "Marlow — please take the next integration-hardening slice".
 *   Pre-fix: wake list derived from To: → ["sable"]; marlow stays
 *   asleep; the handoff dies silently.
 *
 *   Fix: when sender omits `wake`, scan the body for explicit
 *   addressing of CC'd agents. If found, those wake instead of
 *   To:'s default. Sable still gets the mail in inbox; she just
 *   doesn't get a host turn unless explicitly addressed.
 */
describe('deriveWakeFromBody', () => {
  const candidates = ['marlow', 'kepler', 'rivet', 'sable', 'codex'];

  it('matches "Name —" line-leading handoff (the literal screenshot case)', () => {
    const body = 'Integration verification complete.\n\nMarlow — please take the next integration-hardening slice.';
    expect(deriveWakeFromBody(body, candidates)).toEqual(['marlow']);
  });

  it('matches "Name:" colon-leading handoff', () => {
    const body = 'Verification done.\nKepler: pick up the QA wiring next.';
    expect(deriveWakeFromBody(body, candidates)).toEqual(['kepler']);
  });

  it('matches "Name," comma-leading handoff at line start', () => {
    const body = 'Phase 2 wraps here.\nRivet, you have the next slice.';
    expect(deriveWakeFromBody(body, candidates)).toEqual(['rivet']);
  });

  it('matches "@name" mention syntax', () => {
    const body = 'Frontend is solid. @sable can you confirm before we ship?';
    expect(deriveWakeFromBody(body, candidates)).toEqual(['sable']);
  });

  it('matches conversational handoff phrases', () => {
    expect(deriveWakeFromBody('Wiring complete. Handing off to kepler.', candidates)).toEqual(['kepler']);
    expect(deriveWakeFromBody('Done. Over to marlow.', candidates)).toEqual(['marlow']);
    expect(deriveWakeFromBody('All checks pass. Next up: rivet.', candidates)).toEqual(['rivet']);
    expect(deriveWakeFromBody('Hi sable, please verify.', candidates)).toEqual(['sable']);
  });

  it('matches multiple addressees in one body', () => {
    const body = 'Status update.\n\nMarlow — handle the UI badge count.\nKepler — review the integration spec.';
    const result = deriveWakeFromBody(body, candidates);
    expect(result.sort()).toEqual(['kepler', 'marlow']);
  });

  it('does not match name mentions that are not addressing patterns', () => {
    // Mentions of names in casual prose without an addressing anchor
    // should NOT trigger a wake — we only want intentional handoffs.
    const body = 'Earlier today marlow shipped the notifications contract.';
    expect(deriveWakeFromBody(body, candidates)).toEqual([]);
  });

  it('does not match agents who are not in the candidate list', () => {
    // The candidate list scopes who can be woken — names not on it
    // (e.g. an external person mentioned in the body, or an agent
    // who isn't actually on this thread) must not bleed in.
    const body = "Marlow — please continue. Alice — you're CC'd for visibility.";
    expect(deriveWakeFromBody(body, ['marlow', 'kepler'])).toEqual(['marlow']);
  });

  it('is case-insensitive but returns canonical lowercase names', () => {
    expect(deriveWakeFromBody('MARLOW — go.', candidates)).toEqual(['marlow']);
    expect(deriveWakeFromBody('Kepler — go.', ['Kepler', 'Rivet'])).toEqual(['kepler']);
  });

  it('returns [] when the body is empty or candidates empty', () => {
    expect(deriveWakeFromBody('', candidates)).toEqual([]);
    expect(deriveWakeFromBody('Marlow — go.', [])).toEqual([]);
  });

  it('handles very long bodies without pathological backtracking', () => {
    // Body parsing must not be a CPU vector. Cap is 20kB internally.
    const noise = 'lorem ipsum '.repeat(5000);
    const body = `${noise}\n\nMarlow — please continue.`;
    // The match is past the 20k cap, so it should NOT match — and the
    // call should still return quickly (sub-ms in practice). The point
    // here is that the test completes; correctness of "match past 20k"
    // is undefined (we trade away that edge case for DoS resistance).
    const start = Date.now();
    deriveWakeFromBody(body, candidates);
    expect(Date.now() - start).toBeLessThan(100);
  });
});
