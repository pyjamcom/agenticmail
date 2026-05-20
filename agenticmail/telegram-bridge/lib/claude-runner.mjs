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
 * Why standard `claude`, not the Fola harness — AgenticMail ships against
 * the public Claude Code CLI (installed globally as `claude`), not against
 * the agent-harness's vendored build. The harness wrapper exists in
 * `agent-harness/cli.js` and includes its own MCP / persona plumbing the
 * bridge doesn't need. Standard `claude` is simpler, gets the same model
 * via env vars, and avoids the harness becoming a runtime dependency.
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
 * or resumed?" by file existence, identical to how Fola does it.
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
 * Load the Anthropic OAuth bearer for the bridge's spawned `claude` runs.
 *
 * Lookup order — first hit wins:
 *   1. The bridge's own token file at `~/.agenticmail/telegram/anthropic-token`
 *      (so the bot can run under a different account than the operator's
 *      interactive Claude session if desired).
 *   2. The Fola token file at `~/.fola-claude-token` — Fola has had a
 *      working OAuth token there for ages on this machine; reusing it
 *      means the AgenticMail bridge "just works" alongside the existing
 *      Fola bridge without re-authing.
 *   3. The standard `ANTHROPIC_AUTH_TOKEN` env var.
 *
 * Returns { token, source } so the bridge can log which source it picked —
 * stale env tokens are otherwise hard to diagnose in pm2.
 */
export function loadAnthropicToken() {
  if (existsSync(ANTHROPIC_TOKEN_FILE)) {
    const t = readFileSync(ANTHROPIC_TOKEN_FILE, 'utf8').trim();
    if (t) return { token: t, source: 'agenticmail-file' };
  }
  const fola = join(homedir(), '.fola-claude-token');
  if (existsSync(fola)) {
    const t = readFileSync(fola, 'utf8').trim();
    if (t) return { token: t, source: 'fola-file' };
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return { token: process.env.ANTHROPIC_AUTH_TOKEN, source: 'env' };
  }
  return { token: null, source: null };
}

/**
 * Run one prompt through `claude -p`.
 *
 * @param {object} opts
 * @param {string} opts.prompt            The Telegram-message-as-prompt
 * @param {string} opts.sessionId         Per-sender session UUID
 * @param {string} opts.anthropicToken    OAuth bearer from `loadAnthropicToken`
 * @param {number} [opts.timeoutMs]       Hard kill timeout (default 10min — Telegram users won't wait longer)
 * @param {string} [opts.sessionHandoff]  Tail of prior rotated session, injected as system prompt
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
    if (sessionHandoff) args.push('--append-system-prompt', sessionHandoff);
    args.push('-p', prompt);

    const env = {
      ...process.env,
      ...AM_CLAUDE_ENV,
      ANTHROPIC_AUTH_TOKEN: anthropicToken,
    };

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
