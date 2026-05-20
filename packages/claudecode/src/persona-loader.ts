/**
 * Resolves a persona prompt for an AgenticMail agent, with three
 * sources tried in order:
 *
 *   1. `~/.claude/agents/agenticmail-<name>.md` on disk (if present).
 *      Lets the operator customise an agent's behaviour by hand-editing
 *      its file. Owned-by-us files (frontmatter marker) AND user-owned
 *      files are both honoured — the dispatcher trusts whatever is on
 *      disk for that agent.
 *
 *   2. `~/.agenticmail/agents/<name>/persona.md` — the canonical
 *      "soul file" introduced in v0.9.85. Same file the voice runtime
 *      reads, so the agent's identity is consistent across email,
 *      Telegram, and live phone calls. Auto-created with a sensible
 *      default on first read (see `core/src/persona/index.ts`). When
 *      present, the dispatcher prepends it to the generated body so
 *      the operator's edits to the canonical file flow through to
 *      every spawn path including the email worker.
 *
 *   3. In-memory render from live AgenticMail account metadata via
 *      `renderPersonaBody`. This is the path for agents that were just
 *      `create_account`-ed and have no file yet — they become wake-able
 *      immediately, no install step required.
 *
 * Returns the persona BODY (no YAML frontmatter). That's what the
 * Claude Agent SDK consumes as a system prompt.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgentPersona } from '@agenticmail/core';
import type { AgenticMailAccount } from './types.js';
import { renderPersonaBody } from './subagent-template.js';

export interface LoadPersonaOptions {
  agent: AgenticMailAccount;
  /** Directory holding per-agent .md files. Default: ~/.claude/agents. */
  agentsDir: string;
  /** Prefix for filenames. Default: "agenticmail-". */
  subagentPrefix: string;
  /** MCP server name used inside tool examples in the prose. */
  mcpServerName: string;
}

export interface LoadedPersona {
  /** The persona body — system prompt for the worker. */
  body: string;
  /** Where the body came from (for logs / debugging). */
  source: 'file' | 'generated';
  /** Resolved file path if source === 'file'. */
  filePath?: string;
}

function sanitizeSubagentName(name: string): string {
  // Split the trim into two anchored singles — the alternation form
  // is polynomial on input of all dashes (CodeQL `js/polynomial-redos`).
  return name.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/**
 * Extract the body (everything after the closing `---`) from a Markdown
 * file with YAML frontmatter. If the file has no frontmatter, returns
 * the entire content. Robust to leading whitespace and CRLF line endings.
 */
function stripFrontmatter(raw: string): string {
  // Normalise line endings so the regex doesn't need to care.
  const text = raw.replace(/\r\n/g, '\n');
  // Frontmatter must start at byte 0 with "---\n".
  if (!text.startsWith('---\n')) return text;
  const close = text.indexOf('\n---', 4);
  if (close < 0) return text;
  // Skip the closing "---" line and any following blank line(s).
  let cursor = close + 4;
  while (cursor < text.length && (text[cursor] === '\n' || text[cursor] === '\r')) cursor++;
  return text.slice(cursor);
}

/**
 * Try the disk file; fall back to live generation. Pure function — no
 * side effects beyond `loadAgentPersona` lazy-creating the canonical
 * persona file on first read (idempotent + write-once).
 *
 * v0.9.86 — adds the canonical-persona overlay. If the Claude Code
 * subagent file is missing OR contains only frontmatter, we still
 * fall back to a generated body — but we now PREPEND the canonical
 * `~/.agenticmail/agents/<name>/persona.md` content so the dispatcher
 * worker shares identity with the voice runtime and the Telegram
 * bridge. The operator edits ONE file, the change reaches every
 * spawn path.
 */
export function loadPersonaForAgent(opts: LoadPersonaOptions): LoadedPersona {
  const { agent, agentsDir, subagentPrefix, mcpServerName } = opts;
  const basename = sanitizeSubagentName(`${subagentPrefix}${agent.name}`);
  const filePath = join(agentsDir, `${basename}.md`);
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const body = stripFrontmatter(raw).trim();
      if (body) return { body, source: 'file', filePath };
    } catch {
      // Fall through to generated.
    }
  }
  // No subagent file — generate from live account metadata, prefixed
  // with the canonical persona ("soul file"). loadAgentPersona is
  // best-effort: a permission error / disk failure returns an in-
  // memory default rather than throwing, so the dispatcher never
  // crashes here for a filesystem reason.
  let canonical = '';
  try {
    canonical = loadAgentPersona(agent.name).trim();
  } catch {
    // Defensive: an upstream change could theoretically throw despite
    // loadAgentPersona's own try/catch. Don't take the worker down.
    canonical = '';
  }
  const generated = renderPersonaBody({ name: basename, agent, mcpServerName });
  const body = canonical
    ? `${canonical}\n\n---\n\n${generated}`
    : generated;
  return { body, source: 'generated' };
}
