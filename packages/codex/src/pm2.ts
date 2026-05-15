/**
 * PM2 lifecycle for the dispatcher daemon.
 *
 * Why PM2: AgenticMail's existing setup already runs every long-lived
 * agent process (fola-agent, john-agent, enterprise, fola-telegram, etc.)
 * under PM2 — adding our dispatcher there gives us the same auto-restart,
 * boot persistence, and log rotation for free. The alternative
 * (launchctl plist) would work too but would fragment process management.
 *
 * Failure mode: if PM2 isn't installed, `agenticmail codex install`
 * still writes ~/.codex/config.toml + hooks.json + the subagent .toml
 * files. We just skip the dispatcher step and warn the user. They can
 * install PM2 later and re-run `agenticmail codex install` to add the
 * entry.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const DISPATCHER_PM2_NAME = 'agenticmail-codex-dispatcher';

/** Returns true if `pm2` is on PATH and runnable. */
export function pm2Available(): boolean {
  const r = spawnSync('pm2', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

export interface Pm2ProcessInfo {
  name: string;
  pid: number;
  status: string;
  restartCount: number;
  uptime: number;
}

/** Look up the dispatcher process in pm2's list. Returns null if absent. */
export function getDispatcherStatus(): Pm2ProcessInfo | null {
  if (!pm2Available()) return null;
  let raw: string;
  try {
    raw = execFileSync('pm2', ['jlist'], { encoding: 'utf-8' });
  } catch {
    return null;
  }
  let list: Array<Record<string, unknown>>;
  try {
    list = JSON.parse(raw) as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
  for (const proc of list) {
    if (proc.name !== DISPATCHER_PM2_NAME) continue;
    const pm2_env = (proc.pm2_env ?? {}) as Record<string, unknown>;
    const monit = (proc.monit ?? {}) as Record<string, unknown>;
    return {
      name: DISPATCHER_PM2_NAME,
      pid: typeof proc.pid === 'number' ? proc.pid : 0,
      status: typeof pm2_env.status === 'string' ? pm2_env.status : 'unknown',
      restartCount: typeof pm2_env.restart_time === 'number' ? pm2_env.restart_time : 0,
      uptime: typeof pm2_env.pm_uptime === 'number' ? pm2_env.pm_uptime : 0,
      // monit fields (cpu, memory) are available if we ever want them.
      ...(monit ? {} : {}),
    };
  }
  return null;
}

/**
 * Start (or restart) the dispatcher under PM2. Resolves the bin via the
 * caller-supplied path so we don't have to guess where the package lives
 * on the user's machine.
 *
 * Idempotent: if the entry already exists, calls `pm2 restart` instead
 * of `pm2 start` so env-var changes are picked up.
 */
export interface StartDispatcherOptions {
  /** Absolute path to the dispatcher bin (`dist/dispatcher-bin.js`). */
  binPath: string;
  /** Env vars to pass to the dispatcher. */
  env: Record<string, string>;
}

export function startDispatcher(opts: StartDispatcherOptions): { started: boolean; reason?: string } {
  if (!pm2Available()) return { started: false, reason: 'pm2 is not installed (npm install -g pm2)' };
  if (!existsSync(opts.binPath)) return { started: false, reason: `dispatcher bin not found at ${opts.binPath}` };

  const existing = getDispatcherStatus();
  if (existing) {
    // Update env then restart — pm2 doesn't have a clean "update env" op,
    // so we delete + re-add. Atomic enough for our purposes (the gap is
    // ~hundreds of ms during which incoming SSE events would queue inside
    // the master API's per-agent listener buffer).
    spawnSync('pm2', ['delete', DISPATCHER_PM2_NAME], { stdio: 'ignore' });
  }

  const r = spawnSync('pm2', [
    'start',
    opts.binPath,
    '--name', DISPATCHER_PM2_NAME,
    // Restart with exponential backoff up to 10 retries before giving up.
    // The dispatcher's internal SSE reconnect logic handles transient
    // network errors; pm2 catches process-level crashes.
    '--max-restarts', '10',
    '--restart-delay', '2000',
    '--update-env',
  ], {
    env: { ...process.env, ...opts.env },
    stdio: 'inherit',
  });
  if (r.status !== 0) return { started: false, reason: `pm2 start exited ${r.status}` };

  // Persist across reboots — pm2 save writes the current process list to
  // ~/.pm2/dump.pm2 which is replayed by `pm2 resurrect` on boot.
  spawnSync('pm2', ['save'], { stdio: 'ignore' });
  return { started: true };
}

/** Stop and delete the dispatcher under PM2. */
export function stopDispatcher(): { stopped: boolean } {
  if (!pm2Available()) return { stopped: false };
  if (!getDispatcherStatus()) return { stopped: false };
  spawnSync('pm2', ['delete', DISPATCHER_PM2_NAME], { stdio: 'ignore' });
  spawnSync('pm2', ['save'], { stdio: 'ignore' });
  return { stopped: true };
}
