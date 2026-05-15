/**
 * Inspect the current install state of @agenticmail/codex.
 *
 * Used by:
 *   - `agenticmail codex --status` (prints a detailed report)
 *   - tests
 *
 * Forgiving: anything that can't be checked (e.g. API down) is recorded
 * as a note rather than a thrown error. The point of `status` is to help
 * the user fix whatever's wrong, not to surface stack traces.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig, type ResolveConfigOptions } from './config.js';
import { readCodexConfig } from './codex-config-toml.js';
import { getAccountByName, AgenticMailApiError } from './api.js';
import { MANAGED_BY_MARKER } from './subagent-template.js';
import { getDispatcherStatus } from './pm2.js';
import type { InstallStatus } from './types.js';

export async function status(opts: ResolveConfigOptions = {}): Promise<InstallStatus> {
  const cfg = resolveConfig(opts);
  const notes: string[] = [];

  // 1. Is the MCP server registered in Codex's config.toml?
  //    Is the multi_agent_v2 feature flag enabled?
  let mcpInstalled = false;
  let multiAgentEnabled = false;
  if (existsSync(cfg.codexConfigPath)) {
    try {
      const codexCfg = readCodexConfig(cfg.codexConfigPath);
      mcpInstalled = Boolean(codexCfg.mcp_servers?.[cfg.mcpServerName]);
      multiAgentEnabled = codexCfg.features?.multi_agent_v2?.enabled === true;
      if (mcpInstalled && !multiAgentEnabled) {
        notes.push(
          `multi_agent_v2 feature flag is off — Codex won't expose the spawn_agent tool, ` +
          `so AgenticMail subagents will be unreachable from the model. Re-run install to fix.`,
        );
      }
    } catch (err) {
      notes.push(`Could not parse ${cfg.codexConfigPath}: ${(err as Error).message}`);
    }
  } else {
    notes.push(`Codex config not found at ${cfg.codexConfigPath} — Codex CLI may not be installed yet (try \`npm install -g @openai/codex\`).`);
  }

  // 2. Which agent .toml files do we currently own?
  const subagents: string[] = [];
  if (existsSync(cfg.agentsDir)) {
    const prefix = cfg.subagentPrefix.toLowerCase();
    for (const file of readdirSync(cfg.agentsDir)) {
      if (!file.endsWith('.toml')) continue;
      if (!file.toLowerCase().startsWith(prefix)) continue;
      const full = join(cfg.agentsDir, file);
      try {
        const head = readFileSync(full, 'utf-8').slice(0, 1024);
        if (head.includes(MANAGED_BY_MARKER)) subagents.push(file.slice(0, -'.toml'.length));
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

  // 4. Dispatcher status — PM2 may or may not be installed. We don't
  // factor dispatcher presence into the top-level state; it's an
  // enhancement, not a hard prerequisite. The MCP tools all work
  // without it; the only thing missing in a dispatcher-less setup is
  // "agents auto-wake on events".
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
    notes.push('Dispatcher daemon is not running — AgenticMail agents will NOT auto-wake on mail/task events. Re-run `agenticmail codex` to (re)start it.');
  }

  let state: InstallStatus['state'];
  if (mcpInstalled && bridgeAgentExists && subagents.length > 0) state = 'installed';
  else if (!mcpInstalled && !bridgeAgentExists && subagents.length === 0) state = 'not_installed';
  else state = 'partial';

  return {
    state,
    mcpInstalled,
    multiAgentEnabled,
    bridgeAgentExists,
    subagents,
    codexConfigPath: cfg.codexConfigPath,
    codexHooksPath: cfg.codexHooksPath,
    agentsDir: cfg.agentsDir,
    notes,
    dispatcher,
  };
}
