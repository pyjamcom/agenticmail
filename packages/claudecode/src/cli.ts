#!/usr/bin/env node
/**
 * Standalone CLI for @agenticmail/claudecode.
 *
 * Most users will reach this code via `agenticmail claudecode` (a thin wrapper
 * inside the agenticmail top-level CLI that does the same thing with prettier
 * spinners). This binary exists so the package is usable on its own — e.g.
 * `npx @agenticmail/claudecode install` from a Dockerfile, CI script, or any
 * environment where the user does not want to install the full agenticmail
 * shell.
 *
 * Output is plain ANSI — no spinners — because this CLI may run non-interactively
 * (CI logs, JSON consumers, etc.).
 *
 * Usage:
 *   agenticmail-claudecode             # install (default action)
 *   agenticmail-claudecode install
 *   agenticmail-claudecode status      # prints a short summary
 *   agenticmail-claudecode status --json
 *   agenticmail-claudecode uninstall
 *   agenticmail-claudecode uninstall --purge-bridge
 *   agenticmail-claudecode --help
 */

import { install } from './install.js';
import { uninstall } from './uninstall.js';
import { status } from './status.js';
import { AgenticMailApiError } from './api.js';
import { writeDispatcherTuning, resolveDispatcherTuning, defaultDispatcherConfigPath } from './dispatcher-tuning.js';

const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;
const PINK = (s: string) => `\x1b[38;5;205m${s}\x1b[0m`;

function print(msg: string): void { console.log(msg); }
function ok(msg: string): void { console.log(`  ${GREEN('✓')} ${msg}`); }
function fail(msg: string): void { console.error(`  ${RED('✗')} ${msg}`); }
function dim(msg: string): void { console.log(`  ${DIM(msg)}`); }

function usage(): void {
  print('');
  print(`  ${PINK('🎀 AgenticMail for Claude Code')}`);
  print('');
  print(`  ${BOLD('Usage:')} agenticmail-claudecode [command] [flags]`);
  print('');
  print(`  ${BOLD('Commands:')}`);
  print(`    install            Register AgenticMail with Claude Code (default)`);
  print(`    uninstall          Remove the registration`);
  print(`    status             Show what's currently installed`);
  print(`    tune               View / change dispatcher tuning knobs (rate limits, concurrency)`);
  print('');
  print(`  ${BOLD('Flags:')}`);
  print(`    --json             (status / tune) Emit machine-readable JSON instead of prose`);
  print(`    --purge-bridge     (uninstall) Also delete the AgenticMail bridge agent`);
  print('');
  print(`  ${BOLD('Tune flags:')}`);
  print(`    --max-concurrent N         Cap total simultaneous workers across all agents (default 50)`);
  print(`    --max-wakes-per-thread N   Wakes a single (agent, thread) pair gets per window (default 10)`);
  print(`    --wake-window-ms N         Rolling window for the above counter, ms (default 86400000 = 24h)`);
  print(`    --wake-coalesce-ms N       Burst-debounce — collapse rapid replies into one wake (default 30000 = 30s, set 0 to disable)`);
  print(`    --sync-ms N                How often the dispatcher polls /accounts for new agents (default 30000)`);
  print(`    --reset                    Delete ~/.agenticmail/dispatcher.json, return to defaults`);
  print(`    -h, --help         Show this help and exit`);
  print('');
  print(`  ${BOLD('Environment overrides (same effect as the flags above, for PM2 setups):')}`);
  print(`    AGENTICMAIL_API_URL                          Override AgenticMail master API URL`);
  print(`    AGENTICMAIL_MASTER_KEY                       Override master key`);
  print(`    CLAUDE_CODE_CONFIG_PATH                      Override Claude Code config path`);
  print(`    CLAUDE_CODE_AGENTS_DIR                       Override Claude Code agents dir`);
  print(`    AGENTICMAIL_DISPATCHER_MAX                   Same as --max-concurrent`);
  print(`    AGENTICMAIL_DISPATCHER_MAX_WAKES_PER_THREAD  Same as --max-wakes-per-thread`);
  print(`    AGENTICMAIL_DISPATCHER_WAKE_WINDOW_MS        Same as --wake-window-ms`);
  print(`    AGENTICMAIL_DISPATCHER_COALESCE_MS           Same as --wake-coalesce-ms`);
  print(`    AGENTICMAIL_DISPATCHER_SYNC                  Same as --sync-ms`);
  print('');
}

function envOptions(): Record<string, string | undefined> {
  return {
    apiUrl: process.env.AGENTICMAIL_API_URL,
    masterKey: process.env.AGENTICMAIL_MASTER_KEY,
    claudeConfigPath: process.env.CLAUDE_CODE_CONFIG_PATH,
    agentsDir: process.env.CLAUDE_CODE_AGENTS_DIR,
  };
}

/** Strip undefined values so the resolver picks its own defaults instead. */
function clean<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

async function runInstall(): Promise<number> {
  print('');
  print(`  ${PINK('🎀 Installing AgenticMail for Claude Code')}`);
  print('');
  try {
    const result = await install(clean(envOptions()));
    ok(`Bridge agent: ${result.bridgeAgent.name} (${result.bridgeAgent.email})`);
    ok(`MCP server registered in ${result.claudeConfigPath}`);
    ok(`${result.registeredAgents.length} Claude Code subagent${result.registeredAgents.length === 1 ? '' : 's'} written to ${result.agentsDir}`);
    if (result.registeredAgents.length > 0) {
      for (const a of result.registeredAgents) dim(`  • agenticmail-${a.name.toLowerCase()}  →  ${a.email}`);
    }
    print('');
    if (!result.changed) {
      print(`  ${DIM('Already up to date — no files were modified.')}`);
    } else {
      print(`  ${BOLD('Next step:')} restart Claude Code so it picks up the new MCP server.`);
      print(`  ${DIM('Once restarted, try:  Agent { subagent_type: "agenticmail-fola", prompt: "hi" }')}`);
    }
    print('');
    return 0;
  } catch (err) {
    fail((err as Error).message);
    if (err instanceof AgenticMailApiError && err.status === 0) {
      dim('Is the AgenticMail server running? Try: agenticmail start');
    }
    return 1;
  }
}

async function runUninstall(purgeBridge: boolean): Promise<number> {
  print('');
  print(`  ${PINK('🎀 Removing AgenticMail from Claude Code')}`);
  print('');
  try {
    const result = await uninstall({ ...clean(envOptions()), purgeBridgeAgent: purgeBridge });
    if (result.mcpBlockRemoved) ok('Removed MCP server entry from Claude Code config');
    else dim('No MCP server entry was registered.');
    if (result.removedSubagents.length > 0) ok(`Removed ${result.removedSubagents.length} subagent file(s)`);
    else dim('No subagent files were registered.');
    if (result.bridgeAgentDeleted) ok('Deleted bridge agent from AgenticMail');
    else if (purgeBridge) dim('Bridge agent could not be deleted (already gone, or AgenticMail unreachable).');
    print('');
    if (!result.changed) print(`  ${DIM('Nothing to remove.')}`);
    print('');
    return 0;
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }
}

async function runStatus(asJson: boolean): Promise<number> {
  try {
    const result = await status(clean(envOptions()));
    if (asJson) {
      print(JSON.stringify(result, null, 2));
      return result.state === 'installed' ? 0 : 1;
    }
    print('');
    print(`  ${PINK('🎀 AgenticMail for Claude Code')}`);
    print('');
    const stateLabel = result.state === 'installed' ? GREEN('installed')
      : result.state === 'partial' ? `${BOLD('partial')}`
      : DIM('not installed');
    print(`  Status: ${stateLabel}`);
    print(`  MCP server registered: ${result.mcpInstalled ? GREEN('yes') : DIM('no')}`);
    print(`  Bridge agent in AgenticMail: ${result.bridgeAgentExists ? GREEN('yes') : DIM('no')}`);
    print(`  Subagent files: ${result.subagents.length > 0 ? GREEN(String(result.subagents.length)) : DIM('0')}`);
    if (result.subagents.length > 0) for (const s of result.subagents) dim(`  • ${s}`);
    if (result.notes.length > 0) {
      print('');
      print(`  ${BOLD('Notes:')}`);
      for (const n of result.notes) dim(`  • ${n}`);
    }
    print('');
    return result.state === 'installed' ? 0 : 1;
  } catch (err) {
    fail((err as Error).message);
    return 2;
  }
}

/**
 * Parse `--flag N` or `--flag=N` numeric pairs out of argv. Returns
 * undefined if the flag isn't present so the writer can leave the
 * existing on-disk value alone.
 */
function argNum(args: string[], flag: string): number | undefined {
  // Support both "--flag=42" and "--flag 42" forms.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag && i + 1 < args.length) {
      const n = parseInt(args[i + 1], 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    }
    if (a.startsWith(`${flag}=`)) {
      const n = parseInt(a.slice(flag.length + 1), 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    }
  }
  return undefined;
}

async function runTune(args: string[]): Promise<number> {
  const { existsSync, unlinkSync } = await import('node:fs');
  const path = defaultDispatcherConfigPath();
  const asJson = args.includes('--json');

  if (args.includes('--reset')) {
    try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
    if (asJson) {
      print(JSON.stringify({ reset: true, path }, null, 2));
    } else {
      print('');
      print(`  ${PINK('🎀 Dispatcher tuning')}`);
      print('');
      ok(`Reset: deleted ${path}`);
      print(`  ${DIM('The dispatcher will use built-in defaults until you re-tune.')}`);
      print('');
    }
    return 0;
  }

  // Pull only the flags the user passed. Missing → undefined →
  // writeDispatcherTuning preserves the existing on-disk value.
  const patch = {
    maxConcurrentWorkers: argNum(args, '--max-concurrent'),
    maxWakesPerThread: argNum(args, '--max-wakes-per-thread'),
    wakeWindowMs: argNum(args, '--wake-window-ms'),
    wakeCoalesceMs: argNum(args, '--wake-coalesce-ms'),
    accountSyncIntervalMs: argNum(args, '--sync-ms'),
  };
  const anyFlag = Object.values(patch).some(v => v !== undefined);

  if (anyFlag) {
    const merged = writeDispatcherTuning(patch);
    if (asJson) {
      print(JSON.stringify(merged, null, 2));
      return 0;
    }
    print('');
    print(`  ${PINK('🎀 Dispatcher tuning saved')}`);
    print('');
    ok(`Wrote ${path}`);
    dim(`  maxConcurrentWorkers:   ${merged.maxConcurrentWorkers ?? '(default)'}`);
    dim(`  maxWakesPerThread:      ${merged.maxWakesPerThread ?? '(default)'}`);
    dim(`  wakeWindowMs:           ${merged.wakeWindowMs ?? '(default)'}`);
    dim(`  wakeCoalesceMs:         ${merged.wakeCoalesceMs ?? '(default)'}`);
    dim(`  accountSyncIntervalMs:  ${merged.accountSyncIntervalMs ?? '(default)'}`);
    print('');
    print(`  ${BOLD('Next:')} restart the dispatcher daemon to apply.`);
    print(`  ${DIM('pm2 restart agenticmail-claudecode-dispatcher')}`);
    print('');
    return 0;
  }

  // No flags + no --reset = "show me current settings".
  const resolved = resolveDispatcherTuning();
  if (asJson) {
    print(JSON.stringify({ resolved, path }, null, 2));
    return 0;
  }
  print('');
  print(`  ${PINK('🎀 Dispatcher tuning (current)')}`);
  print('');
  print(`  Config file: ${path}`);
  print('');
  print(`  ${BOLD('Effective values (env > file > built-in default):')}`);
  dim(`  maxConcurrentWorkers:   ${resolved.maxConcurrentWorkers ?? '50 (default)'}`);
  dim(`  maxWakesPerThread:      ${resolved.maxWakesPerThread ?? '10 (default)'}`);
  dim(`  wakeWindowMs:           ${resolved.wakeWindowMs ?? '86400000 (default — 24h)'}`);
  dim(`  wakeCoalesceMs:         ${resolved.wakeCoalesceMs ?? '30000 (default — 30s)'}`);
  dim(`  accountSyncIntervalMs:  ${resolved.accountSyncIntervalMs ?? '30000 (default)'}`);
  print('');
  print(`  ${BOLD('Change with flags, e.g.:')}`);
  dim(`  agenticmail-claudecode tune --max-wakes-per-thread 100 --max-concurrent 200`);
  print('');
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help') || args[0] === 'help') {
    usage();
    return 0;
  }
  const command = args.find(a => !a.startsWith('-')) ?? 'install';
  switch (command) {
    case 'install':
      return runInstall();
    case 'uninstall':
    case 'remove':
      return runUninstall(args.includes('--purge-bridge'));
    case 'status':
      return runStatus(args.includes('--json'));
    case 'tune':
      return runTune(args);
    default:
      fail(`Unknown command: ${command}`);
      usage();
      return 64; // EX_USAGE
  }
}

main().then(code => process.exit(code)).catch(err => {
  fail((err as Error).message);
  process.exit(1);
});
