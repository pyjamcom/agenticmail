/**
 * AgenticMail's Claude runner for the Telegram bridge.
 *
 * Spawns the standard `claude` CLI (Claude Code) in print mode (`-p`) with
 * the incoming Telegram message as the prompt. Captures stdout — whatever
 * Claude writes to stdout becomes the bot's reply to the user. The first
 * turn of a sender gets `--session-id <uuid>`; subsequent turns get
 * `--resume <same-uuid>` so each Telegram user has one continuous
 * conversation that survives bridge restarts.
 *
 * Always uses the standard, publicly-installed `claude` binary — the
 * one a user gets from `npm install -g @anthropic-ai/claude-code`.
 * Custom Claude wrappers (vendored builds with extra MCP / persona
 * plumbing) are deliberately NOT used: they would become a runtime
 * dependency of every install, and the bridge's needs are met by
 * the standard CLI plus the MCP server we wire in via `--mcp-config`.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  ANTHROPIC_TOKEN_FILE,
  AM_CLAUDE_ENV,
  TG_DIR,
} from './paths.mjs';

/** Canonical Claude binary on macOS/Linux installs — falls back to PATH. */
function claudeBin() {
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'claude'; // assume PATH
}

/**
 * Session file written by Claude Code's `-p` mode.
 *
 * Claude Code writes session jsonl to
 * `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl`, where sanitized
 * cwd replaces `/` with `-`. We always run with `cwd = TG_DIR` so the
 * mapping is predictable and the bridge can detect "is this session new
 * or resumed?" by file existence, same pattern Claude Code itself uses for its --resume flag.
 */
export function sessionFilePath(sessionId) {
  // Claude Code's actual project-dir sanitisation replaces BOTH `/` AND `.`
  // with `-` when mapping a cwd to a name under `~/.claude/projects/`.
  // Earlier versions of this function only replaced `/`, which made
  // `sessionExists` always return false for any cwd containing a dot
  // (and `~/.agenticmail/telegram` always does); the bridge then passed
  // `--session-id <uuid>` on EVERY turn instead of switching to `--resume`
  // on turn 2+, and Claude rejected the second turn with `Session ID
  // <uuid> is already in use.` Mirror the full sanitisation rule here.
  const sanitized = TG_DIR.replace(/[/.]/g, '-');
  return join(homedir(), '.claude', 'projects', sanitized, `${sessionId}.jsonl`);
}

export function sessionExists(sessionId) {
  return existsSync(sessionFilePath(sessionId));
}

/**
 * Load the Anthropic API key or OAuth bearer for spawned `claude` runs.
 *
 * Lookup order — first hit wins:
 *   1. The bridge's own token file at
 *      `~/.agenticmail/telegram/anthropic-token` — operator-owned,
 *      0600. The bot can run under a different account than the
 *      operator's interactive Claude session if desired.
 *   2. The shared AgenticMail token file at
 *      `~/.agenticmail/anthropic-token` — also operator-owned, shared
 *      with the claudecode dispatcher so a single token grants both
 *      paths without copying.
 *   3. The standard `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`
 *      env var (typical pm2 ecosystem.config.cjs setup).
 *
 * Returns { token, source } so the bridge can log which source it
 * picked — stale env tokens are otherwise hard to diagnose in pm2.
 */
export function loadAnthropicToken() {
  if (existsSync(ANTHROPIC_TOKEN_FILE)) {
    const t = readFileSync(ANTHROPIC_TOKEN_FILE, 'utf8').trim();
    if (t) return { token: t, source: 'agenticmail-telegram-file' };
  }
  const shared = join(homedir(), '.agenticmail', 'anthropic-token');
  if (existsSync(shared)) {
    const t = readFileSync(shared, 'utf8').trim();
    if (t) return { token: t, source: 'agenticmail-shared-file' };
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return { token: process.env.ANTHROPIC_AUTH_TOKEN, source: 'env' };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { token: process.env.ANTHROPIC_API_KEY, source: 'env' };
  }
  return { token: null, source: null };
}

/**
 * Run one prompt through `claude -p`.
 *
 * @param {object} opts
 * @param {string} opts.prompt            The Telegram-message-as-prompt
 * @param {string} opts.sessionId         Per-sender session UUID
 * @param {string} opts.anthropicToken    API key or OAuth bearer from `loadAnthropicToken`
 * @param {number} [opts.timeoutMs]       Hard kill timeout (default 10min — Telegram users won't wait longer)
 * @param {string} [opts.sessionHandoff]  Tail of prior rotated session, injected as system prompt
 * @param {string} [opts.personaPrompt]   v0.9.86 — agent persona ("soul file"), prepended to the
 *                                          system prompt so the Telegram-chat Claude shares identity
 *                                          with the voice runtime and the email worker. Loaded once
 *                                          at bridge startup; same string on every call.
 * @param {string} [opts.mcpConfig]       Optional --mcp-config path (off by default)
 * @param {function} [opts.onLog]         stderr line sink for debugging
 * @param {function} [opts.onSpawn]       Called with the spawned ChildProcess so the bridge
 *                                         can kill it on a Telegram "stop" command
 * @returns {Promise<{ stdout: string, stderr: string, sessionId: string }>}
 */
export function runClaude(opts) {
  const {
    prompt,
    sessionId,
    anthropicToken,
    timeoutMs = 10 * 60 * 1000,
    sessionHandoff,
    personaPrompt,
    mcpConfig,
    onLog = () => {},
    onSpawn,
  } = opts;

  return new Promise((resolve, reject) => {
    const exists = sessionExists(sessionId);
    const sessionArgs = exists
      ? ['--resume', sessionId]
      : ['--session-id', sessionId];

    const args = [
      '--dangerously-skip-permissions',
      ...sessionArgs,
    ];
    if (mcpConfig) args.push('--mcp-config', mcpConfig);
    // v0.9.86 — persona + session-handoff both ride the SAME
    // --append-system-prompt flag (claude accepts only one). Persona
    // first, then the rotated-session tail, so identity context sits
    // above conversation-resume context in the system prompt.
    const systemParts = [];
    if (personaPrompt) systemParts.push(personaPrompt.trim());
    if (sessionHandoff) systemParts.push(sessionHandoff.trim());
    if (systemParts.length > 0) {
      args.push('--append-system-prompt', systemParts.join('\n\n---\n\n'));
    }
    args.push('-p', prompt);

    const env = {
      ...process.env,
      ...AM_CLAUDE_ENV,
    };
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    if (anthropicToken.startsWith('sk-ant-oat01-')) {
      env.ANTHROPIC_AUTH_TOKEN = anthropicToken;
    } else {
      env.ANTHROPIC_API_KEY = anthropicToken;
    }

    const child = spawn(claudeBin(), args, {
      cwd: TG_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detached process group so pm2's SIGINT to the bridge doesn't kill
      // the child mid-response and truncate the user's reply. The bridge's
      // deferred-shutdown handler waits up to 90s for active workers.
      detached: true,
    });
    child.unref();
    if (typeof onSpawn === 'function') {
      try { onSpawn(child); } catch {}
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split('\n')) if (line.trim()) onLog(line.trim());
    });

    const killTimer = setTimeout(() => {
      onLog(`run exceeded ${Math.round(timeoutMs / 1000)}s timeout, killing`);
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), sessionId });
      } else {
        const msg = `claude exited code=${code} signal=${signal}`;
        const full = stderr.trim() ? `${msg}\nstderr: ${stderr.trim().slice(0, 2000)}` : msg;
        reject(new Error(full));
      }
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}
