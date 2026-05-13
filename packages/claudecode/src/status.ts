/**
 * Inspect the current install state of @agenticmail/claudecode.
 *
 * Used by:
 *   - `agenticmail status` (top-level command, prints a one-line summary)
 *   - `agenticmail claudecode --status` (prints a detailed report)
 *   - tests
 *
 * The function is forgiving: anything that can't be checked (e.g. API down)
 * is recorded as a note rather than a thrown error. The point of `status` is
 * to help the user fix whatever's wrong, not to surface stack traces.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig, type ResolveConfigOptions } from './config.js';
import { readClaudeConfig } from './claude-config.js';
import { getAccountByName, AgenticMailApiError } from './api.js';
import { MANAGED_BY_MARKER } from './subagent-template.js';
import { getDispatcherStatus } from './pm2.js';
import type { InstallStatus } from './types.js';

export async function status(opts: ResolveConfigOptions = {}): Promise<InstallStatus> {
  const cfg = resolveConfig(opts);
  const notes: string[] = [];

  // 1. Is the MCP server registered in Claude Code's config?
  let mcpInstalled = false;
  if (existsSync(cfg.claudeConfigPath)) {
    try {
      const claudeCfg = readClaudeConfig(cfg.claudeConfigPath);
      mcpInstalled = Boolean(claudeCfg.mcpServers?.[cfg.mcpServerName]);
    } catch (err) {
      notes.push(`Could not parse ${cfg.claudeConfigPath}: ${(err as Error).message}`);
    }
  } else {
    notes.push(`Claude Code config not found at ${cfg.claudeConfigPath} — Claude Code may not be installed yet.`);
  }

  // 2. Which subagent .md files do we currently own?
  // Use the prefix verbatim (lower-cased) — do not run it through any
  // basename sanitizer, which would strip the legitimate trailing dash and
  // make the matcher over-broad.
  const subagents: string[] = [];
  if (existsSync(cfg.agentsDir)) {
    const prefix = cfg.subagentPrefix.toLowerCase();
    for (const file of readdirSync(cfg.agentsDir)) {
      if (!file.endsWith('.md')) continue;
      if (!file.toLowerCase().startsWith(prefix)) continue;
      const full = join(cfg.agentsDir, file);
      try {
        const head = readFileSync(full, 'utf-8').slice(0, 1024);
        if (head.includes(MANAGED_BY_MARKER)) subagents.push(file.slice(0, -3));
      } catch { /* skip */ }
    }
  }

  // 3. Does the bridge agent still exist in AgenticMail?
  let bridgeAgentExists = false;
  if (cfg.masterKey) {
    try {
      const bridge = await getAccountByName(cfg.apiUrl, cfg.masterKey, cfg.bridgeAgentName);
      bridgeAgentExists = Boolean(bridge);
      if (!bridge && mcpInstalled) {
        notes.push(`MCP server is registered but bridge agent "${cfg.bridgeAgentName}" is missing in AgenticMail — re-run install to recreate it.`);
      }
    } catch (err) {
      if (err instanceof AgenticMailApiError) {
        notes.push(`Could not reach AgenticMail at ${cfg.apiUrl}: ${err.message}`);
      } else {
        notes.push((err as Error).message);
      }
    }
  } else {
    notes.push('AgenticMail master key not found — run `agenticmail setup` to initialize.');
  }

  // Dispatcher status — PM2 may or may not be installed. We do NOT factor
  // dispatcher presence into the top-level state; it is an enhancement,
  // not a hard prerequisite. The MCP tools all work without it; the only
  // thing missing in a dispatcher-less setup is "agents auto-wake on
  // events". Status surfaces this in `notes` if appropriate.
  const dispatcherInfo = getDispatcherStatus();
  const dispatcher = dispatcherInfo
    ? {
        running: dispatcherInfo.status === 'online',
        pid: dispatcherInfo.pid,
        restartCount: dispatcherInfo.restartCount,
        uptimeMs: dispatcherInfo.uptime ? Date.now() - dispatcherInfo.uptime : undefined,
      }
    : null;
  if (mcpInstalled && (!dispatcher || !dispatcher.running)) {
    notes.push('Dispatcher daemon is not running — AgenticMail agents will NOT auto-wake on mail/task events. Re-run `agenticmail claudecode` to (re)start it.');
  }

  let state: InstallStatus['state'];
  if (mcpInstalled && bridgeAgentExists && subagents.length > 0) state = 'installed';
  else if (!mcpInstalled && !bridgeAgentExists && subagents.length === 0) state = 'not_installed';
  else state = 'partial';

  return {
    state,
    mcpInstalled,
    bridgeAgentExists,
    subagents,
    claudeConfigPath: cfg.claudeConfigPath,
    agentsDir: cfg.agentsDir,
    notes,
    dispatcher,
  };
}
