#!/usr/bin/env node

/**
 * npm preuninstall hook.
 *
 * Runs automatically when the user does:
 *   npm uninstall -g @agenticmail/claudecode
 *
 * Removes:
 *   - the mcpServers.agenticmail block from ~/.claude.json (if present)
 *   - every Claude Code subagent .md file we wrote (frontmatter marker:
 *     "@agenticmail/claudecode") in ~/.claude/agents/
 *
 * Deliberately does NOT:
 *   - delete the bridge agent inside AgenticMail (destructive — preserve it
 *     so the user's inbox isn't lost)
 *   - touch anything in ~/.claude.json other than the single mcpServers key
 *
 * Implemented in pure-node JS (no TS, no dist/ dependency) so this works
 * even when the package's build output is missing — npm sometimes runs
 * preuninstall *after* dist/ has been removed.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MCP_SERVER_NAME = process.env.AGENTICMAIL_MCP_SERVER_NAME ?? 'agenticmail';
const CLAUDE_CONFIG = process.env.CLAUDE_CODE_CONFIG_PATH ?? join(homedir(), '.claude.json');
const AGENTS_DIR = process.env.CLAUDE_CODE_AGENTS_DIR ?? join(homedir(), '.claude', 'agents');
const SUBAGENT_PREFIX = 'agenticmail-';
const MARKER = '@agenticmail/claudecode';

function atomicWrite(path, text) {
  const tmp = `${path}.agenticmail-tmp`;
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, path);
}

let touched = false;

// 1. Remove the MCP server block.
if (existsSync(CLAUDE_CONFIG)) {
  try {
    const raw = readFileSync(CLAUDE_CONFIG, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.mcpServers && Object.prototype.hasOwnProperty.call(parsed.mcpServers, MCP_SERVER_NAME)) {
      delete parsed.mcpServers[MCP_SERVER_NAME];
      atomicWrite(CLAUDE_CONFIG, JSON.stringify(parsed, null, 2) + '\n');
      console.log(`[agenticmail] Removed mcpServers.${MCP_SERVER_NAME} from ${CLAUDE_CONFIG}`);
      touched = true;
    }
  } catch (err) {
    console.warn(`[agenticmail] Could not patch ${CLAUDE_CONFIG}: ${err.message}`);
  }
}

// 2. Remove owned subagent .md files.
if (existsSync(AGENTS_DIR)) {
  for (const file of readdirSync(AGENTS_DIR)) {
    if (!file.startsWith(SUBAGENT_PREFIX) || !file.endsWith('.md')) continue;
    const full = join(AGENTS_DIR, file);
    let head;
    try { head = readFileSync(full, 'utf-8').slice(0, 1024); } catch { continue; }
    if (!head.includes(MARKER)) continue;
    try {
      unlinkSync(full);
      console.log(`[agenticmail] Removed ${full}`);
      touched = true;
    } catch (err) {
      console.warn(`[agenticmail] Could not remove ${full}: ${err.message}`);
    }
  }
}

if (!touched) {
  // Silent success — nothing was registered, nothing to do.
}
