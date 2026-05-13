/**
 * Resolves a persona prompt for an AgenticMail agent, with two sources
 * tried in order:
 *
 *   1. `~/.claude/agents/agenticmail-<name>.md` on disk (if present).
 *      Lets the operator customise an agent's behaviour by hand-editing
 *      its file. Owned-by-us files (frontmatter marker) AND user-owned
 *      files are both honoured — the dispatcher trusts whatever is on
 *      disk for that agent.
 *
 *   2. In-memory render from live AgenticMail account metadata via
 *      `renderPersonaBody`. This is the path for agents that were just
 *      `create_account`-ed and have no file yet — they become wake-able
 *      immediately, no install step required.
 *
 * Returns the persona BODY (no YAML frontmatter). That's what the
 * Claude Agent SDK consumes as a system prompt.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
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
 * side effects, no API calls (the account metadata is passed in).
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
  // No file — generate from live account metadata.
  const body = renderPersonaBody({ name: basename, agent, mcpServerName });
  return { body, source: 'generated' };
}
