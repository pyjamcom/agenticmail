/**
 * Read / write / patch ~/.claude.json safely.
 *
 * Claude Code's config file is owned by the user — it stores OAuth state,
 * onboarding flags, project list, MCP server registrations, and a lot more.
 * We touch ONE key (`mcpServers[<name>]`) and nothing else.
 *
 * Notes on the format:
 *   - The file is JSON (not JSON5, despite the agenticmail CLI using JSON5
 *     elsewhere). `JSON.parse` is enough.
 *   - The file may not exist on a fresh install — we treat that as an empty
 *     object and create the file when we write.
 *   - We preserve the existing top-level structure to avoid clobbering keys
 *     we don't recognise.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/** Shape of a single MCP server registration in Claude Code's config. */
export interface ClaudeMcpServerEntry {
  /** Transport — defaults to "stdio" in Claude Code. */
  type?: 'stdio' | 'http' | 'sse';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Optional URL (for http/sse transports). */
  url?: string;
}

/** Loose typing — Claude Code's config has many keys we don't care about. */
export interface ClaudeConfigShape {
  mcpServers?: Record<string, ClaudeMcpServerEntry>;
  [key: string]: unknown;
}

export function readClaudeConfig(path: string): ClaudeConfigShape {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as ClaudeConfigShape;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch (err) {
    throw new Error(
      `Could not parse Claude Code config at ${path}: ${(err as Error).message}. ` +
      `Refusing to overwrite — please fix the file by hand and retry.`,
    );
  }
}

/**
 * Atomically write Claude Code's config. The file may grow large (we've seen
 * 1.7k lines on a long-running install), so we always pretty-print with 2-
 * space indent to keep diffs reviewable.
 */
export function writeClaudeConfig(path: string, config: ClaudeConfigShape): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(config, null, 2) + '\n';
  // Two-step write so we don't leave a truncated file if the process dies
  // mid-write. The shape of Claude Code's config makes a partial-write very
  // damaging (the user can be logged out etc.).
  const tmp = `${path}.agenticmail-tmp`;
  writeFileSync(tmp, text, 'utf-8');
  // Same-filesystem rename is atomic on POSIX; on Windows it's "atomic enough"
  // (the destination either exists with the old contents or the new — never
  // partially written). That's why we go through a tmp file rather than
  // writing directly: a partial ~/.claude.json can log the user out.
  renameSync(tmp, path);
}

/** Insert (or replace) a single MCP server entry. Returns true if the file changed. */
export function upsertMcpServer(
  path: string,
  serverName: string,
  entry: ClaudeMcpServerEntry,
): boolean {
  const config = readClaudeConfig(path);
  const servers = config.mcpServers ?? {};
  const existing = servers[serverName];
  if (existing && deepEqual(existing, entry)) return false;
  servers[serverName] = entry;
  config.mcpServers = servers;
  writeClaudeConfig(path, config);
  return true;
}

/** Remove a single MCP server entry. Returns true if the file changed. */
export function removeMcpServer(path: string, serverName: string): boolean {
  if (!existsSync(path)) return false;
  const config = readClaudeConfig(path);
  if (!config.mcpServers || !(serverName in config.mcpServers)) return false;
  delete config.mcpServers[serverName];
  // If mcpServers is now empty, leave the empty object — Claude Code tolerates
  // it and other tooling may rely on the key existing. Cheap and safe.
  writeClaudeConfig(path, config);
  return true;
}

/** Recursive structural equality — only good enough for the small entry shape we use. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
      if (!deepEqual(ao[ak[i]], bo[bk[i]])) return false;
    }
    return true;
  }
  return false;
}
