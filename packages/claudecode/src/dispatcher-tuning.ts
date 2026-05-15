/**
 * Tuning knobs for the dispatcher daemon.
 *
 * # Why this exists
 *
 * The dispatcher has several rate-limit / concurrency knobs that need
 * to be tunable WITHOUT a code change:
 *
 *   - `maxConcurrentWorkers` — global worker cap (default 50)
 *   - `maxWakesPerThread`    — wakes per (agent, thread) per window (default 10)
 *   - `wakeWindowMs`         — the window itself (default 24h)
 *   - `wakeCoalesceMs`       — burst-debounce window (default 30s)
 *   - `accountSyncIntervalMs` — how often to poll /accounts (default 30s)
 *
 * The DEFAULTS are conservative — protect a fresh install from runaway
 * cost. Power users running active coordination on a single thread
 * routinely hit the 10/24h wake cap and need it raised. Today (before
 * this module) the only way to do that was edit dispatcher.ts and rebuild,
 * which is absurd.
 *
 * # Three input sources, in precedence order
 *
 *   1. Explicit constructor args (programmatic callers, tests)
 *   2. Env vars (PM2 ecosystem.config.cjs lives here)
 *   3. `~/.agenticmail/dispatcher.json` (persistent operator preference,
 *      written by the CLI's `agenticmail dispatcher tune` command)
 *   4. Hard-coded defaults
 *
 * Earlier sources win.
 *
 * # File format
 *
 *   { "version": 1,
 *     "maxConcurrentWorkers": 200,
 *     "maxWakesPerThread": 50,
 *     "wakeWindowMs": 86400000,
 *     "wakeCoalesceMs": 30000,
 *     "accountSyncIntervalMs": 30000 }
 *
 * Missing keys fall through to the next precedence level. All values
 * are integers; non-positive / non-finite values fall through (so a
 * broken edit produces a slightly-stale config, not a broken
 * dispatcher).
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface DispatcherTuning {
  maxConcurrentWorkers?: number;
  maxWakesPerThread?: number;
  wakeWindowMs?: number;
  wakeCoalesceMs?: number;
  accountSyncIntervalMs?: number;
}

export function defaultDispatcherConfigPath(): string {
  return join(homedir(), '.agenticmail', 'dispatcher.json');
}

function positiveInt(s: string | number | undefined | null): number | undefined {
  if (s === undefined || s === null || s === '') return undefined;
  const n = typeof s === 'number' ? s : parseInt(String(s), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Read the on-disk tuning file. Missing / unreadable / wrong-version →
 * empty object. Malformed individual values are silently dropped so a
 * stray non-numeric value can't break the entire file's worth of
 * preferences.
 */
function readTuningFile(path: string): DispatcherTuning {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { version?: number } & DispatcherTuning;
    if (!parsed || typeof parsed !== 'object') return {};
    if (parsed.version !== 1) return {};
    return {
      maxConcurrentWorkers: positiveInt(parsed.maxConcurrentWorkers),
      maxWakesPerThread: positiveInt(parsed.maxWakesPerThread),
      wakeWindowMs: positiveInt(parsed.wakeWindowMs),
      wakeCoalesceMs: positiveInt(parsed.wakeCoalesceMs),
      accountSyncIntervalMs: positiveInt(parsed.accountSyncIntervalMs),
    };
  } catch {
    return {};
  }
}

/**
 * Resolve final tuning values by merging the three precedence layers:
 * explicit args > env vars > file > defaults (left to the consumer).
 *
 * Returns ONLY the keys that were explicitly set — the caller passes
 * the result through to the Dispatcher constructor, whose defaults
 * fill in anything still undefined.
 */
export function resolveDispatcherTuning(opts: {
  explicit?: DispatcherTuning;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
} = {}): DispatcherTuning {
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? defaultDispatcherConfigPath();
  const fileLayer = readTuningFile(configPath);
  const envLayer: DispatcherTuning = {
    maxConcurrentWorkers: positiveInt(env.AGENTICMAIL_DISPATCHER_MAX),
    maxWakesPerThread: positiveInt(env.AGENTICMAIL_DISPATCHER_MAX_WAKES_PER_THREAD),
    wakeWindowMs: positiveInt(env.AGENTICMAIL_DISPATCHER_WAKE_WINDOW_MS),
    wakeCoalesceMs: positiveInt(env.AGENTICMAIL_DISPATCHER_COALESCE_MS),
    accountSyncIntervalMs: positiveInt(env.AGENTICMAIL_DISPATCHER_SYNC),
  };
  const explicit = opts.explicit ?? {};
  // Order matters: explicit > env > file > undefined (default).
  return {
    maxConcurrentWorkers:
      explicit.maxConcurrentWorkers ?? envLayer.maxConcurrentWorkers ?? fileLayer.maxConcurrentWorkers,
    maxWakesPerThread:
      explicit.maxWakesPerThread ?? envLayer.maxWakesPerThread ?? fileLayer.maxWakesPerThread,
    wakeWindowMs:
      explicit.wakeWindowMs ?? envLayer.wakeWindowMs ?? fileLayer.wakeWindowMs,
    wakeCoalesceMs:
      explicit.wakeCoalesceMs ?? envLayer.wakeCoalesceMs ?? fileLayer.wakeCoalesceMs,
    accountSyncIntervalMs:
      explicit.accountSyncIntervalMs ?? envLayer.accountSyncIntervalMs ?? fileLayer.accountSyncIntervalMs,
  };
}

/**
 * Persist the operator's preferences to ~/.agenticmail/dispatcher.json
 * atomically (.tmp + rename) so a power outage mid-write never produces
 * a half-written config. Only writes the keys that are explicitly set
 * in the patch — preserves keys the user already configured.
 *
 * Returns the resulting on-disk shape so the caller can echo it back.
 */
export function writeDispatcherTuning(
  patch: DispatcherTuning,
  configPath: string = defaultDispatcherConfigPath(),
): DispatcherTuning & { version: number; updatedAtMs: number } {
  const current = readTuningFile(configPath);
  const merged = {
    version: 1 as const,
    updatedAtMs: Date.now(),
    maxConcurrentWorkers: positiveInt(patch.maxConcurrentWorkers) ?? current.maxConcurrentWorkers,
    maxWakesPerThread: positiveInt(patch.maxWakesPerThread) ?? current.maxWakesPerThread,
    wakeWindowMs: positiveInt(patch.wakeWindowMs) ?? current.wakeWindowMs,
    wakeCoalesceMs: positiveInt(patch.wakeCoalesceMs) ?? current.wakeCoalesceMs,
    accountSyncIntervalMs: positiveInt(patch.accountSyncIntervalMs) ?? current.accountSyncIntervalMs,
  };
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, configPath);
  return merged;
}
