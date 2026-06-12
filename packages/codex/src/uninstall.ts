/**
 * Uninstall AgenticMail from Codex CLI.
 *
 * Reverses everything install() did, in the opposite order, with one
 * deliberate exception: we keep the bridge agent in AgenticMail by
 * default.
 *
 * Why?  The bridge agent owns an inbox, may have ongoing conversations,
 * and may be referenced from other agents' contact lists. Silently
 * deleting it during a Codex uninstall is destructive in a way users
 * would not expect. Pass { purgeBridgeAgent: true } if you really want
 * it gone.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tryJoin } from '@agenticmail/core';
import { deleteAccount, getAccountByName } from './api.js';
import { resolveConfig, type ResolveConfigOptions } from './config.js';
import { removeMcpServer } from './codex-config-toml.js';
import { removeMailHook, removeOpenCraterHook } from './codex-hooks-config.js';
import { MANAGED_BY_MARKER } from './subagent-template.js';
import { stopDispatcher } from './pm2.js';
import type { UninstallResult } from './types.js';

export interface UninstallOptions extends ResolveConfigOptions {
  /**
   * Also delete the bridge agent from AgenticMail. Default false — see
   * header comment. Setting this to true is irreversible (the agent's
   * API key, inbox folder layout, and contact references will all be
   * invalidated).
   */
  purgeBridgeAgent?: boolean;
}

/**
 * Walk the agents dir, remove every .toml we own, return their names.
 *
 * The prefix is taken verbatim (lower-cased) — we deliberately do NOT
 * pass it through any normalisation, which would otherwise strip
 * trailing dashes and cause the matcher to swallow files with similar
 * names.
 */
function removeOwnedSubagents(agentsDir: string, prefix: string): string[] {
  if (!existsSync(agentsDir)) return [];
  const safePrefix = prefix.toLowerCase();
  const removed: string[] = [];
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith('.toml')) continue;
    if (!file.toLowerCase().startsWith(safePrefix)) continue;
    // tryJoin returns null on a path-traversal attempt (e.g. a
    // symlinked filename containing `..` segments). Skip silently
    // rather than risk deleting outside agentsDir.
    const full = tryJoin(agentsDir, file);
    if (!full) continue;
    let head: string;
    try { head = readFileSync(full, 'utf-8').slice(0, 1024); } catch { continue; }
    if (!head.includes(MANAGED_BY_MARKER)) continue; // user-owned, hands off
    try { unlinkSync(full); removed.push(file); } catch { /* best effort */ }
  }
  return removed;
}

export async function uninstall(opts: UninstallOptions = {}): Promise<UninstallResult> {
  const cfg = resolveConfig(opts);

  const mcpBlockRemoved = removeMcpServer(cfg.codexConfigPath, cfg.mcpServerName);
  const removedSubagents = removeOwnedSubagents(cfg.agentsDir, cfg.subagentPrefix);

  // Pull the mail-hook out of hooks.json. Removes SessionStart +
  // UserPromptSubmit + Stop entries (and any leftover registrations on
  // events we no longer use).
  let hooksRemoved = false;
  try { hooksRemoved = removeMailHook(cfg.codexHooksPath); }
  catch { /* best-effort */ }
  try { removeOpenCraterHook(cfg.codexHooksPath); }
  catch { /* best-effort */ }

  // Stop the dispatcher BEFORE deleting the bridge agent so the daemon
  // doesn't see a transient account-disappeared event mid-shutdown.
  const dispatcherStopped = stopDispatcher().stopped;

  let bridgeAgentDeleted = false;
  if (opts.purgeBridgeAgent && cfg.masterKey) {
    try {
      const bridge = await getAccountByName(cfg.apiUrl, cfg.masterKey, cfg.bridgeAgentName);
      if (bridge) {
        await deleteAccount(cfg.apiUrl, cfg.masterKey, bridge.id);
        bridgeAgentDeleted = true;
      }
    } catch {
      // We tried — leave the bridge dangling rather than fail the whole
      // uninstall. The user can clean it up by hand via the master CLI.
    }
  }

  return {
    changed:
      mcpBlockRemoved ||
      removedSubagents.length > 0 ||
      hooksRemoved ||
      bridgeAgentDeleted ||
      dispatcherStopped,
    removedSubagents,
    mcpBlockRemoved,
    hooksRemoved,
    bridgeAgentDeleted,
    dispatcherStopped,
  };
}

// We intentionally do NOT clear features.multi_agent_v2.enabled on
// uninstall. The user may have enabled it themselves before installing,
// or other workflows (the user's own subagent .toml files) may depend
// on it. Once turned on, that flag stays on; turning it off is a
// distinct user decision, not a side effect of removing our package.
