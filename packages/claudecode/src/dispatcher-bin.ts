#!/usr/bin/env node
/**
 * Standalone bin: `agenticmail-claudecode-dispatcher`.
 *
 * This is what PM2 (or any process supervisor) runs. It builds a
 * Dispatcher with config pulled from env vars + ~/.agenticmail/config.json,
 * starts it, and stays alive until SIGINT/SIGTERM — at which point it
 * cleanly closes every SSE channel before exiting.
 *
 * Env overrides (same as the rest of the package):
 *   AGENTICMAIL_API_URL          Override master API URL.
 *   AGENTICMAIL_MASTER_KEY       Override master key.
 *   CLAUDE_CODE_AGENTS_DIR       Override agents dir (for persona files).
 *   AGENTICMAIL_DISPATCHER_MAX   Concurrency cap (default 10).
 *   AGENTICMAIL_DISPATCHER_SYNC  Account sync interval ms (default 60000).
 */

import { Dispatcher } from './dispatcher.js';

async function main(): Promise<void> {
  const dispatcher = new Dispatcher({
    apiUrl: process.env.AGENTICMAIL_API_URL,
    masterKey: process.env.AGENTICMAIL_MASTER_KEY,
    agentsDir: process.env.CLAUDE_CODE_AGENTS_DIR,
    maxConcurrentWorkers: positiveInt(process.env.AGENTICMAIL_DISPATCHER_MAX),
    accountSyncIntervalMs: positiveInt(process.env.AGENTICMAIL_DISPATCHER_SYNC),
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

  // Unhandled rejections inside the dispatcher's internal loops are
  // already caught and logged. Surface anything else (e.g. SDK import
  // failures at bin startup) so PM2 can decide to restart.
  process.on('unhandledRejection', (reason) => {
    console.error('[dispatcher-bin] unhandledRejection:', reason);
  });

  await dispatcher.start();
  // Stay alive — the dispatcher's intervals keep the event loop busy,
  // but we don't await on anything here; signals do the unblocking.
}

function positiveInt(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

main().catch(err => {
  console.error(`[dispatcher-bin] fatal: ${(err as Error).message}`);
  process.exit(1);
});
