#!/usr/bin/env node
/**
 * Standalone bin: `agenticmail-codex-dispatcher`.
 *
 * This is what PM2 (or any process supervisor) runs. It builds a
 * Dispatcher with config pulled from env vars + ~/.agenticmail/config.json,
 * starts it, and stays alive until SIGINT/SIGTERM — at which point it
 * cleanly closes every SSE channel before exiting.
 *
 * Env overrides (same as @agenticmail/claudecode for symmetry):
 *   AGENTICMAIL_API_URL          Override master API URL.
 *   AGENTICMAIL_MASTER_KEY       Override master key.
 *   CODEX_AGENTS_DIR             Override agents dir (for persona files).
 *   AGENTICMAIL_DISPATCHER_MAX   Concurrency cap (default 50).
 *   AGENTICMAIL_DISPATCHER_SYNC  Account sync interval ms (default 30000).
 *
 * The Codex CLI itself reads `CODEX_HOME` to find its config; the
 * dispatcher doesn't need that — it talks to the AgenticMail API for
 * mail events and shells out to the Codex SDK for worker spawns, and
 * the SDK looks up CODEX_HOME on its own.
 */

import { Dispatcher } from './dispatcher.js';

async function main(): Promise<void> {
  const dispatcher = new Dispatcher({
    apiUrl: process.env.AGENTICMAIL_API_URL,
    masterKey: process.env.AGENTICMAIL_MASTER_KEY,
    agentsDir: process.env.CODEX_AGENTS_DIR,
    maxConcurrentWorkers: positiveInt(process.env.AGENTICMAIL_DISPATCHER_MAX),
    accountSyncIntervalMs: positiveInt(process.env.AGENTICMAIL_DISPATCHER_SYNC),
  });

  // Graceful shutdown on the usual signals (PM2 sends SIGINT on stop).
  const shutdown = async (sig: NodeJS.Signals) => {
    console.error(`[codex-dispatcher-bin] received ${sig} — shutting down`);
    try { await dispatcher.stop(); } catch (err) {
      console.error(`[codex-dispatcher-bin] error during shutdown: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // CRITICAL: the dispatcher must NEVER crash on a single bad event.
  // Same guards as @agenticmail/claudecode/dispatcher-bin.ts:
  //   1. unhandledRejection — stray promise without .catch()
  //   2. uncaughtException — synchronous throw from third-party code
  //                          (ImapFlow, the SDK, etc.)
  //
  // We do NOT process.exit() in either handler — the dispatcher is a
  // long-lived daemon and the safer default is to absorb the error
  // and continue. If something is structurally broken (config drift,
  // master-key revoked), the operator will see the repeated log lines
  // and restart manually.
  process.on('unhandledRejection', (reason) => {
    console.error('[codex-dispatcher-bin] unhandledRejection (continuing):', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[codex-dispatcher-bin] uncaughtException (continuing):', err);
  });

  await dispatcher.start();
  // Stay alive — the dispatcher's intervals keep the event loop busy.
}

function positiveInt(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

main().catch(err => {
  console.error(`[codex-dispatcher-bin] fatal: ${(err as Error).message}`);
  process.exit(1);
});
