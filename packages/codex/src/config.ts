/**
 * Resolves a fully-populated CodexIntegrationConfig from defaults + overrides
 * + the on-disk AgenticMail config (~/.agenticmail/config.json).
 *
 * Reading the master key from disk lives here (not in install.ts) so tests
 * can supply config inline without touching the filesystem.
 *
 * # Codex vs Claude Code paths
 *
 * Claude Code keeps its global config at `~/.claude.json` (one JSON file)
 * and its hooks + settings at `~/.claude/settings.json`. Codex CLI is
 * structured differently:
 *
 *   ~/.codex/config.toml      — global config, including `[mcp_servers.*]`
 *                               and `features.multi_agent_v2.enabled`
 *   ~/.codex/hooks.json       — lifecycle hooks (separate file, not nested)
 *   ~/.codex/agents/<name>.toml — one TOML file per custom subagent
 *   ~/.codex/sessions/        — Codex's own thread rollouts (resumeThread)
 *
 * `CODEX_HOME` env var overrides `~/.codex`. We honour it the same way the
 * Codex CLI itself does in `codex-rs/core/src/config/mod.rs::resolve_codex_home`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CodexIntegrationConfig } from './types.js';

const AGENTICMAIL_CONFIG_PATH = join(homedir(), '.agenticmail', 'config.json');

/** Public options for resolveConfig — everything is optional and overrides defaults. */
export interface ResolveConfigOptions {
  apiUrl?: string;
  masterKey?: string;
  /** Override CODEX_HOME (defaults to env var or ~/.codex). */
  codexHome?: string;
  /** Override the agents directory inside CODEX_HOME (defaults to `<codexHome>/agents`). */
  agentsDir?: string;
  /** MCP server entry name in [mcp_servers.*]. Default: 'agenticmail'. */
  mcpServerName?: string;
  /** Name of the dedicated AgenticMail account that represents this Codex install. */
  bridgeAgentName?: string;
  /** Prefix for generated Codex subagent names. */
  subagentPrefix?: string;
  /** MCP server command + args (defaults to npx-fallback). */
  mcpCommand?: string;
  mcpArgs?: string[];
  /** Override path to AgenticMail's config.json (defaults to ~/.agenticmail/config.json). Tests use this. */
  agenticmailConfigPath?: string;
}

interface AgenticMailOnDiskConfig {
  masterKey?: string;
  api?: { port?: number; host?: string };
}

function readAgenticMailConfig(path: string): AgenticMailOnDiskConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AgenticMailOnDiskConfig;
  } catch {
    return {};
  }
}

/**
 * Resolve the Codex home directory the same way the CLI does:
 *   1. Explicit override.
 *   2. $CODEX_HOME env var.
 *   3. ~/.codex.
 */
export function resolveCodexHome(override?: string): string {
  if (override) return override;
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  return join(homedir(), '.codex');
}

/**
 * MCP server invocation. Prefers `agenticmail-mcp` on PATH (when the user
 * has installed @agenticmail/mcp globally), falls back to `npx -y` so the
 * integration works without any prior setup.
 *
 * We don't shell out to `which` — this is called during config building and
 * must be cheap + side-effect-free. The npx fallback works everywhere.
 */
function defaultMcpInvocation(): { command: string; args: string[] } {
  return { command: 'npx', args: ['-y', '@agenticmail/mcp'] };
}

export function resolveConfig(opts: ResolveConfigOptions = {}): CodexIntegrationConfig {
  const amConfigPath = opts.agenticmailConfigPath ?? AGENTICMAIL_CONFIG_PATH;
  const onDisk = readAgenticMailConfig(amConfigPath);

  const apiHost = onDisk.api?.host ?? '127.0.0.1';
  // Fallback port matches @agenticmail/core's default; should rarely be hit
  // in practice since the on-disk config.json carries the real port.
  const apiPort = onDisk.api?.port ?? 3829;
  const defaultApiUrl = `http://${apiHost}:${apiPort}`;

  const codexHome = resolveCodexHome(opts.codexHome);
  const defaultInvocation = defaultMcpInvocation();
  const masterKey = opts.masterKey ?? onDisk.masterKey ?? '';

  return {
    apiUrl: opts.apiUrl ?? defaultApiUrl,
    masterKey,
    codexHome,
    codexConfigPath: join(codexHome, 'config.toml'),
    codexHooksPath: join(codexHome, 'hooks.json'),
    agentsDir: opts.agentsDir ?? join(codexHome, 'agents'),
    mcpServerName: opts.mcpServerName ?? 'agenticmail',
    bridgeAgentName: opts.bridgeAgentName ?? 'codex',
    subagentPrefix: opts.subagentPrefix ?? 'agenticmail-',
    mcpCommand: opts.mcpCommand ?? defaultInvocation.command,
    mcpArgs: opts.mcpArgs ?? defaultInvocation.args,
  };
}
