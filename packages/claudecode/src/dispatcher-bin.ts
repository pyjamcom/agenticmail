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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Dispatcher } from './dispatcher.js';
import { resolveDispatcherTuning } from './dispatcher-tuning.js';

/**
 * Resolve the Anthropic OAuth bearer the dispatcher should hand to
 * `@anthropic-ai/claude-agent-sdk`'s `query()`.
 *
 * Background — Anthropic's recent policy lets an organisation
 * disable Claude-subscription access for Claude Code WITHOUT
 * disabling Claude itself. When that flips, the SDK's default auth
 * path (subscription-routed Claude Code) fails with `Your organization
 * has disabled Claude subscription access for Claude Code` even
 * though the operator's interactive `claude` CLI still works AND the
 * Telegram bridge keeps working — because the bridge spawns `claude
 * -p` with `ANTHROPIC_AUTH_TOKEN` set, which routes the request as a
 * direct bearer instead of through the subscription policy check.
 *
 * The dispatcher used to inherit `ANTHROPIC_AUTH_TOKEN` only if pm2
 * happened to have it in env. Now we look in the standard
 * token-file locations first (same order the Telegram bridge uses) so
 * a default install Just Works without the operator having to edit
 * pm2's env config or export anything globally:
 *
 *   1. `~/.agenticmail/anthropic-token`  — AgenticMail-owned location.
 *   2. `~/.fola-claude-token`            — the original agent-harness
 *                                          token file. Operators on
 *                                          this machine already have
 *                                          it for the Fola bridge; if
 *                                          they used it the cli's
 *                                          claudecode integration
 *                                          installer copies the path
 *                                          forward.
 *   3. `process.env.ANTHROPIC_AUTH_TOKEN` — already set by the
 *                                          operator / pm2 ecosystem.
 *   4. `process.env.ANTHROPIC_API_KEY`    — pay-per-token API path
 *                                          (different from OAuth but
 *                                          accepted by the SDK).
 *
 * Sets `process.env.ANTHROPIC_AUTH_TOKEN` from the first matching
 * file so the SDK reads it on import. No-op when the token is
 * already set or no file is found (the SDK will then attempt its
 * default Claude Code subscription path, which is correct for orgs
 * that haven't flipped the policy flag).
 */
function ensureAnthropicTokenInEnv(): void {
  if (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return;
  const candidates = [
    join(homedir(), '.agenticmail', 'anthropic-token'),
    join(homedir(), '.fola-claude-token'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const token = readFileSync(path, 'utf-8').trim();
      if (token) {
        process.env.ANTHROPIC_AUTH_TOKEN = token;
        // Log source (suffix only — never the whole token) so an
        // operator debugging auth issues can see which file the
        // dispatcher picked up without exposing the bearer.
        console.error(`[dispatcher-bin] anthropic token source: ${path} (suffix ...${token.slice(-6)})`);
        return;
      }
    } catch { /* try the next path */ }
  }
}

async function main(): Promise<void> {
  ensureAnthropicTokenInEnv();
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
