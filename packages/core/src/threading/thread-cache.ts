/**
 * Per-thread message cache — Layer 1 of the wake-context system.
 *
 * # What it stores
 *
 * Each thread (keyed by the stable `threadIdFor` hash) gets a JSON
 * file containing the last K message envelopes that were seen on
 * the thread:
 *
 *   { threadId, subject, rootFromAddr, lastUpdated, messages: [
 *     { uid, from, subject, preview, date }
 *   ]}
 *
 * # What it does NOT store
 *
 * - Full message bodies. Storing the body would multiply the cache
 *   size 20x and most agents don't need it on rehydration — they
 *   need to see "who said what about what" at a glance, not the
 *   exact prose. The dedicated `read_email(uid)` MCP tool serves
 *   the body when the agent actually wants it.
 *
 * # Lifecycle
 *
 * - Built passively: the dispatcher calls `pushMessage(t, env)` on
 *   every SSE new-mail event for the thread, even when no agent
 *   actually wakes. Selective-wake skips, circuit-breaker mutes,
 *   `[FINAL]` markers — none of them prevent the cache from being
 *   populated. The cache is always up to date.
 *
 * - Read on every spawn: `readCache(t)` is called before the
 *   dispatcher fires a worker, and the result is rendered into
 *   the wake prompt.
 *
 * - Pruned on close: `cleanupThread(t)` is called when the
 *   dispatcher detects a thread-close marker. Removes the file
 *   immediately; 7-day grace via empty-tombstone is not needed
 *   because the agent's own memory file handles "did this
 *   thread actually close" semantics.
 *
 * - LRU-bounded: a directory-level LRU (default 5000 threads, ~25 MB)
 *   runs at the head of every write to keep disk usage flat.
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, statSync, rmSync, renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_DIR_DEFAULT = join(homedir(), '.agenticmail', 'thread-cache');
const DEFAULT_K_MESSAGES = 10;
const DEFAULT_LRU_CAP = 5000;
const PREVIEW_MAX_CHARS = 240;

export interface CachedMessage {
  uid: number;
  /** Display name OR raw address — whichever was on the envelope. */
  from: string;
  /** Sender's bare email (post-normalization). Same value used to
   *  derive the thread root, so agents can spot "did I write this?"
   *  with one equality check. */
  fromAddr: string;
  subject: string;
  /** Up to ~240 chars of plain-text body. */
  preview: string;
  /** ISO string. */
  date: string;
}

export interface ThreadCacheEntry {
  threadId: string;
  /** First-seen normalized subject — kept on the entry so the wake
   *  prompt can show it without re-normalizing. */
  subject: string;
  /** First-seen root sender. Used to keep `threadIdFor` stable on
   *  subsequent replies (which carry the replier's `from`, not
   *  the original). */
  rootFromAddr: string;
  /** ms timestamp of most recent write. Drives LRU eviction. */
  lastUpdated: number;
  /** Newest-first. We cap at K — drop oldest on push. */
  messages: CachedMessage[];
}

export interface ThreadCacheOptions {
  /** Override the on-disk root. Mainly for tests. */
  cacheDir?: string;
  /** Newest-N messages kept per thread. */
  k?: number;
  /** Max threads on disk before LRU eviction kicks in. */
  lruCap?: number;
}

export class ThreadCache {
  private readonly dir: string;
  private readonly k: number;
  private readonly lruCap: number;

  constructor(opts: ThreadCacheOptions = {}) {
    this.dir = opts.cacheDir ?? CACHE_DIR_DEFAULT;
    this.k = opts.k ?? DEFAULT_K_MESSAGES;
    this.lruCap = opts.lruCap ?? DEFAULT_LRU_CAP;
    try { mkdirSync(this.dir, { recursive: true }); } catch { /* preexisting or fs read-only */ }
  }

  private pathFor(threadId: string): string {
    return join(this.dir, `${threadId}.json`);
  }

  read(threadId: string): ThreadCacheEntry | null {
    const p = this.pathFor(threadId);
    if (!existsSync(p)) return null;
    try {
      const raw = readFileSync(p, 'utf-8');
      return JSON.parse(raw) as ThreadCacheEntry;
    } catch {
      // Corrupt file — better to evict than to crash callers. The
      // next push will recreate it cleanly.
      try { rmSync(p, { force: true }); } catch { /* ignore */ }
      return null;
    }
  }

  /**
   * Append a message to the thread's cache, pruning to the K
   * newest entries. Creates the cache entry on first write.
   *
   * `rootFromAddr` is the sender of the ROOT message on the
   * thread; on a brand-new thread this is just `env.fromAddr`,
   * on a reply it's read off the existing cache entry (callers
   * should pass the existing entry's rootFromAddr when known).
   */
  pushMessage(threadId: string, env: CachedMessage, meta: { subject: string; rootFromAddr: string }): ThreadCacheEntry {
    const existing = this.read(threadId);
    const entry: ThreadCacheEntry = existing
      ? {
        ...existing,
        // We re-affirm subject + rootFromAddr to existing values —
        // the first-seen values win. Reply messages carry the
        // replier's `from`, not the original sender's, so we'd
        // corrupt the thread root if we overwrote here.
        subject: existing.subject,
        rootFromAddr: existing.rootFromAddr,
        lastUpdated: Date.now(),
        messages: dedupAndCap([env, ...existing.messages], this.k),
      }
      : {
        threadId,
        subject: meta.subject,
        rootFromAddr: meta.rootFromAddr,
        lastUpdated: Date.now(),
        messages: [env],
      };
    this.writeAtomic(threadId, entry);
    this.maybeEvict();
    return entry;
  }

  /** Permanently remove a thread's cache (called on [FINAL] / [DONE] / [CLOSED] / [WRAP]). */
  delete(threadId: string): void {
    try { rmSync(this.pathFor(threadId), { force: true }); } catch { /* ignore */ }
  }

  /**
   * Render the cache as a compact text block for the wake prompt.
   * One line per message, newest first. Empty string when the
   * cache is empty — caller decides whether to suppress the
   * header in that case.
   */
  renderForPrompt(entry: ThreadCacheEntry | null): string {
    if (!entry || entry.messages.length === 0) return '';
    return entry.messages.map(m => {
      const preview = m.preview.replace(/\s+/g, ' ').slice(0, PREVIEW_MAX_CHARS);
      return `- UID ${m.uid} · ${m.from} · ${m.date} · "${m.subject}" · ${preview}`;
    }).join('\n');
  }

  private writeAtomic(threadId: string, entry: ThreadCacheEntry): void {
    const p = this.pathFor(threadId);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
    renameSync(tmp, p);
  }

  /**
   * Best-effort LRU eviction. Runs at most every 256 writes (we
   * don't track a precise counter — `Math.random()` sampling keeps
   * the write path cheap). When the directory has more files than
   * `lruCap`, sort by mtime ascending and delete the oldest 10%.
   */
  private maybeEvict(): void {
    if (Math.random() > 1 / 256) return;
    let files: string[];
    try { files = readdirSync(this.dir).filter(f => f.endsWith('.json')); }
    catch { return; }
    if (files.length <= this.lruCap) return;
    const stats = files.map(f => {
      const p = join(this.dir, f);
      try { return { p, mtime: statSync(p).mtimeMs }; }
      catch { return { p, mtime: 0 }; }
    });
    stats.sort((a, b) => a.mtime - b.mtime);
    const dropCount = Math.max(1, Math.floor(this.lruCap * 0.1));
    for (let i = 0; i < dropCount; i++) {
      try { rmSync(stats[i].p, { force: true }); } catch { /* ignore */ }
    }
  }
}

function dedupAndCap(messages: CachedMessage[], k: number): CachedMessage[] {
  // Same UID can re-arrive (resync, IDLE replay). Newest version
  // wins — that's the first occurrence in the prepended array.
  const seen = new Set<number>();
  const out: CachedMessage[] = [];
  for (const m of messages) {
    if (seen.has(m.uid)) continue;
    seen.add(m.uid);
    out.push(m);
    if (out.length >= k) break;
  }
  return out;
}
