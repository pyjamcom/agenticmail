/**
 * Persisted host-session registry.
 *
 * # What this is for
 *
 * When a sub-agent replies into a host bridge inbox
 * (`claudecode@localhost` / `codex@localhost` / etc.), the dispatcher
 * historically had no way to react: bridges are skipped by
 * `shouldWatch` because they belong to the human operator's host CLI,
 * not to an automated worker. The mail would sit unread until the
 * operator opened their CLI again — sometimes hours later, sometimes
 * never that day.
 *
 * This module is the missing link. Every time the host's mail-hook
 * fires (on `SessionStart` / `UserPromptSubmit` / `Stop`), it captures
 * the host CLI's current `session_id` and persists it here. The
 * dispatcher can then check "what session was running last?" and
 * attempt a headless resume against it when bridge mail arrives —
 * the same way Telegram bridges (Fola, etc.) keep a session alive
 * between bursts of activity.
 *
 * # The file
 *
 * `~/.agenticmail/host-sessions.json`:
 *
 * ```json
 * {
 *   "version": 1,
 *   "sessions": {
 *     "claudecode": {
 *       "sessionId": "01a2b3c4-…",
 *       "workspace": "/Users/ope/Desktop/facebook-project",
 *       "lastSeenMs": 1778905200000,
 *       "model": "claude-sonnet-4-5"
 *     },
 *     "codex": {
 *       "sessionId": "019a2b3c-…",
 *       "workspace": "/Users/ope/Desktop/facebook-project",
 *       "lastSeenMs": 1778905100000
 *     },
 *     "openclaw": {
 *       "sessionId": "openclaw-session-key",
 *       "workspace": "/Users/ope/Desktop/facebook-project",
 *       "lastSeenMs": 1778905000000,
 *       "resumeMode": "wake"
 *     }
 *   }
 * }
 * ```
 *
 * Per host we keep ONE session — the most recent. If the operator
 * runs `claude` twice (e.g. one window for "general", one for "build
 * the LinkedIn clone"), we only track the last-active one. The
 * bridge resume always targets whichever was active most recently;
 * the operator's intuition matches that ("I just left my Claude
 * Code session a minute ago and the bridge ought to be able to
 * resume it").
 *
 * # Freshness semantics
 *
 * A session is considered "resumable" if `lastSeenMs` is within the
 * last 24 hours. Older than that, both Anthropic and OpenAI tend to
 * have evicted the session from their resume cache (cost-driven
 * decision; observed empirically). The dispatcher uses
 * `isSessionFresh(session, maxAgeMs)` to gate the resume attempt and
 * fall through to SMS / persistent storage when stale.
 *
 * # Atomic writes
 *
 * The mail-hook can fire concurrently with another hook on a
 * different host CLI window. The write path goes through a tmp file
 * + rename so a torn write can never leave a half-valid JSON file
 * that crashes the next reader. Same shape as `dispatcher-state.ts`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Canonical names for the host integrations that own bridge inboxes. */
export type HostName = 'claudecode' | 'codex' | 'openclaw' | 'gemini' | 'hermes';

/**
 * How a host can be woken from a persisted session record.
 *
 * - `resume`: the host can resume a durable prior conversation/thread.
 * - `wake`: the host can target a live or recently known session key, but does
 *   not guarantee full headless resume semantics.
 * - `wake-only`: the host can receive a wake notification, but the dispatcher
 *   must not treat it as a resumed worker turn.
 */
export type HostSessionResumeMode = 'resume' | 'wake' | 'wake-only';

/**
 * A snapshot of one host CLI's last-known session. Persisted to disk
 * by the mail-hook on every fire; loaded by the dispatcher when
 * bridge mail arrives so a resume can be attempted.
 */
export interface HostSession {
  /** Stable session_id/thread_id/session key from the host CLI/runtime. */
  sessionId: string;
  /** Wall-clock timestamp of the last hook fire on this session. */
  lastSeenMs: number;
  /** Optional: project cwd the host CLI was opened in. Used by
   *  resume to spawn the headless turn in the right directory. */
  workspace?: string;
  /** Optional: model name the host session was using, surfaced
   *  in logs for diagnostic context. */
  model?: string;
  /** Optional: describes whether this host supports true resume or only wake. */
  resumeMode?: HostSessionResumeMode;
  /** Optional host-specific metadata. Must not contain secrets. */
  hostMetadata?: Record<string, unknown>;
}

interface OnDiskShape {
  version: 1;
  sessions: Partial<Record<HostName, HostSession>>;
}

// Resolved lazily so tests can override `homedir()` per-test without
// having to pre-construct the storage path before the module loads.
function storageDir(): string { return join(homedir(), '.agenticmail'); }
function storagePath(): string { return join(storageDir(), 'host-sessions.json'); }

/** Default freshness window — sessions older than this are skipped. */
export const DEFAULT_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;  // 24h

function readFile(): OnDiskShape {
  const p = storagePath();
  if (!existsSync(p)) return { version: 1, sessions: {} };
  try {
    const raw = readFileSync(p, 'utf-8');
    if (!raw.trim()) return { version: 1, sessions: {} };
    const parsed = JSON.parse(raw) as Partial<OnDiskShape>;
    return {
      version: 1,
      sessions: (parsed.sessions && typeof parsed.sessions === 'object')
        ? (parsed.sessions as Partial<Record<HostName, HostSession>>)
        : {},
    };
  } catch {
    // Corrupt file — treat as empty rather than crash. The next save
    // will overwrite it with a valid shape.
    return { version: 1, sessions: {} };
  }
}

function writeFile(shape: OnDiskShape): void {
  const dir = storageDir();
  const p = storagePath();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${p}.agenticmail-tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(shape, null, 2), 'utf-8');
  // Same-filesystem rename = atomic. A reader can never see a torn
  // file even if the writer is killed mid-rename.
  renameSync(tmp, p);
}

/**
 * Record the current host session. Called from the mail-hook on
 * every fire with the `session_id` the host passed in. Updates the
 * existing record for that host or creates one — last write wins.
 *
 * Failures are swallowed so the mail-hook never crashes the host CLI
 * over a disk write. The bridge-wake path tolerates a missing record
 * (falls through to SMS).
 */
export function saveHostSession(host: HostName, session: Omit<HostSession, 'lastSeenMs'>): void {
  if (!session.sessionId) return;
  try {
    const shape = readFile();
    shape.sessions[host] = {
      ...session,
      lastSeenMs: Date.now(),
    };
    writeFile(shape);
  } catch {
    // Best-effort. The dispatcher's fallback path catches the
    // "no session known" case gracefully.
  }
}

/**
 * Look up the most-recent session for a host. Returns null when no
 * record exists OR the record is older than `maxAgeMs` (default 24h).
 *
 * The age gate exists because both providers expire resume tokens
 * after roughly a day; attempting resume against a stale token is
 * almost always slower than starting fresh.
 */
export function loadHostSession(host: HostName, maxAgeMs = DEFAULT_SESSION_MAX_AGE_MS): HostSession | null {
  const shape = readFile();
  const record = shape.sessions[host];
  if (!record) return null;
  if (!isSessionFresh(record, maxAgeMs)) return null;
  return record;
}

/**
 * Pure freshness predicate — exported for tests + for callers that
 * want to read the raw record (e.g. to print "last seen 2 hours ago"
 * in a diagnostic command).
 */
export function isSessionFresh(session: HostSession, maxAgeMs = DEFAULT_SESSION_MAX_AGE_MS): boolean {
  if (!session || !Number.isFinite(session.lastSeenMs)) return false;
  return (Date.now() - session.lastSeenMs) <= maxAgeMs;
}

/**
 * Clear a host's recorded session. Called when the operator runs
 * `agenticmail-<host> uninstall` so the next install doesn't try to
 * resume a session that no longer exists.
 */
export function forgetHostSession(host: HostName): void {
  try {
    const shape = readFile();
    if (!shape.sessions[host]) return;
    delete shape.sessions[host];
    writeFile(shape);
  } catch { /* best-effort */ }
}

/** Exposed for tests + the `agenticmail status` diagnostic command. */
export function hostSessionStoragePath(): string {
  return storagePath();
}
