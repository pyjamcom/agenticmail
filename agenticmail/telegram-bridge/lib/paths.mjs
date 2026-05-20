/**
 * Canonical paths for AgenticMail's Telegram bridge service.
 *
 * Ported from agent-harness/fola-lib/paths.mjs — same layout, all state under
 * `~/.agenticmail/telegram/` so the bridge co-exists cleanly with the rest of
 * AgenticMail's per-user state at `~/.agenticmail/`.
 */

import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// telegram-bridge/lib/paths.mjs → telegram-bridge/
export const BRIDGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// All bridge state lives under ~/.agenticmail/telegram/.
export const AM_DIR = join(homedir(), '.agenticmail');
export const TG_DIR = join(AM_DIR, 'telegram');

// Anthropic OAuth token — the Claude Code CLI's standard location, with a
// per-bridge override at ~/.agenticmail/telegram/anthropic-token so we don't
// trample the operator's interactive Claude session if they want to use a
// different account for the bot.
export const ANTHROPIC_TOKEN_FILE = join(TG_DIR, 'anthropic-token');

// Telegram bridge state — names match the proven Fola layout so the field
// semantics are identical and porting the bridge body needed no rename work.
export const TELEGRAM_TOKEN_FILE = join(TG_DIR, 'telegram-token');
export const TELEGRAM_ALLOWED_IDS_FILE = join(TG_DIR, 'telegram-allowed-ids');
export const TELEGRAM_OFFSET_FILE = join(TG_DIR, 'telegram-offset.json');
export const TELEGRAM_SESSIONS_FILE = join(TG_DIR, 'telegram-sessions.json');
export const TELEGRAM_WEBHOOK_CONFIG_FILE = join(TG_DIR, 'telegram-webhook.json');
export const TELEGRAM_MEDIA_DIR = join(TG_DIR, 'telegram-media');
// Legacy single-session file (the sessions.mjs library reads it on first boot;
// AgenticMail has no legacy to migrate, but the file is harmless if absent).
export const TELEGRAM_LEGACY_SESSION_FILE = join(TG_DIR, 'telegram-session-id');

// Alias the bridge dir as `FOLA_DIR` so the copied lib files (sessions.mjs,
// telegram-api.mjs) keep working without renaming. They only use it to
// `mkdir -p` their state dir on demand.
export const FOLA_DIR = TG_DIR;

// MCP config the spawned Claude turn should load. The bridge currently runs
// Claude without MCP servers (it has direct Telegram delivery, no MCP tools
// needed), but the path is kept so future per-turn tool wiring is one line.
export const MCP_CONFIG_FILE = join(TG_DIR, 'mcp-config.json');

// Env that every Claude spawn inherits — matches the Fola production config
// (Opus 4.6 in fast mode, telemetry off, generous API timeout).
export const AM_CLAUDE_ENV = {
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  ANTHROPIC_MODEL: 'claude-opus-4-7[1m]',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  API_TIMEOUT_MS: '600000',
};
