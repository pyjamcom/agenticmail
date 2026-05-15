#!/usr/bin/env node
/**
 * Standalone bin: `agenticmail-claudecode-dispatcher`.
 *
 * This is what PM2 (or any process supervisor) runs. It builds a
 * Dispatcher with config pulled from env vars + ~/.agenticmail/config.json
 * + ~/.agenticmail/dispatcher.json, starts it, and stays alive until
 * SIGINT/SIGTERM — at which point it cleanly closes every SSE channel
 * before exiting.
 *
 * Tuning knobs (all optional, precedence env > file > default):
 *
 *   AGENTICMAIL_DISPATCHER_MAX                    — max concurrent workers (default 50)
 *   AGENTICMAIL_DISPATCHER_MAX_WAKES_PER_THREAD   — wakes per (agent, thread) per window (default 10)
 *   AGENTICMAIL_DISPATCHER_WAKE_WINDOW_MS         — window length ms (default 86_400_000 = 24h)
 *   AGENTICMAIL_DISPATCHER_COALESCE_MS            — burst-debounce window (default 30_000 = 30s)
 *   AGENTICMAIL_DISPATCHER_SYNC                   — account sync interval ms (default 30_000)
 *
 * Persistent config: ~/.agenticmail/dispatcher.json — same keys (camelCase),
 * minus the AGENTICMAIL_DISPATCHER_ prefix. See dispatcher-tuning.ts.
 *
 * Identity knobs:
 *   AGENTICMAIL_API_URL          Override master API URL.
 *   AGENTICMAIL_MASTER_KEY       Override master key.
 *   CLAUDE_CODE_AGENTS_DIR       Override agents dir (for persona files).
 */

import { Dispatcher } from './dispatcher.js';
import { resolveDispatcherTuning } from './dispatcher-tuning.js';

async function main(): Promise<void> {
  const tuning = resolveDispatcherTuning();
  console.error(
    `[dispatcher-bin] tuning: maxConcurrentWorkers=${tuning.maxConcurrentWorkers ?? '(default)'} ` +
    `maxWakesPerThread=${tuning.maxWakesPerThread ?? '(default)'} ` +
    `wakeWindowMs=${tuning.wakeWindowMs ?? '(default)'} ` +
    `wakeCoalesceMs=${tuning.wakeCoalesceMs ?? '(default)'} ` +
    `accountSyncIntervalMs=${tuning.accountSyncIntervalMs ?? '(default)'}`,
  );
  const dispatcher = new Dispatcher({
    apiUrl: process.env.AGENTICMAIL_API_URL,
    masterKey: process.env.AGENTICMAIL_MASTER_KEY,
    agentsDir: process.env.CLAUDE_CODE_AGENTS_DIR,
    maxConcurrentWorkers: tuning.maxConcurrentWorkers,
    maxWakesPerThread: tuning.maxWakesPerThread,
    wakeWindowMs: tuning.wakeWindowMs,
    wakeCoalesceMs: tuning.wakeCoalesceMs,
    accountSyncIntervalMs: tuning.accountSyncIntervalMs,
  });

  // Graceful shutdown on the usual signals (PM2 sends SIGINT on stop).
  const shutdown = async (sig: NodeJS.Signals) => {
    console.error(`[dispatcher-bin] received ${sig} — shutting down`);
    try { await dispatcher.stop(); } catch (err) {
      console.error(`[dispatcher-bin] error during shutdown: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // CRITICAL: the dispatcher must NEVER crash on a single bad
  // event. Two guards:
  //
  // 1. unhandledRejection — a stray promise without a .catch()
  //    (e.g. a transient fetch failure deep in the SSE reader
  //    that bypassed our try/catch). We log + survive.
  //
  // 2. uncaughtException — a synchronous throw from third-party
  //    code (ImapFlow, the SDK, etc.). Without this guard Node
  //    would terminate the process and PM2 would restart it,
  //    causing the broadcast-crash failure mode the user
  //    reported: 50 simultaneous wakes hit one bad codepath
  //    and the whole dispatcher dies. With it, the dispatcher
  //    logs the error and keeps running.
  //
  // We do NOT process.exit() in either handler — the dispatcher
  // is a long-lived daemon and the safer default is to absorb
  // the error and continue. If something is structurally
  // broken (config drift, master-key revoked), the operator
  // will see the repeated log lines and restart manually.
  process.on('unhandledRejection', (reason) => {
    console.error('[dispatcher-bin] unhandledRejection (continuing):', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[dispatcher-bin] uncaughtException (continuing):', err);
  });

  await dispatcher.start();
  // Stay alive — the dispatcher's intervals keep the event loop busy,
  // but we don't await on anything here; signals do the unblocking.
}

main().catch(err => {
  console.error(`[dispatcher-bin] fatal: ${(err as Error).message}`);
  process.exit(1);
});
