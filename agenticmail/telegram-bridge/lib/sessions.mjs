/**
 * Per-sender session management.
 *
 * Maintains a persistent map of {senderId → sessionId} in
 * telegram-sessions.json so each Telegram user gets their own continuous
 * conversation with Claude. Migrates from the legacy single-session file
 * on first boot.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  FOLA_DIR,
  TELEGRAM_SESSIONS_FILE,
  TELEGRAM_LEGACY_SESSION_FILE,
} from './paths.mjs';

// Session rotation: max size before starting a fresh session.
// Bumped from the original 5MB ceiling — Claude Code's
// auto-compaction handles 100s-of-MB sessions cleanly, and rotating
// a multi-day conversation off because the on-disk log crossed 5MB
// surprised callers more than it protected anyone. The new ceiling
// is generous enough that only genuinely-runaway sessions trigger
// rotation while real long-running conversations (180MB+ observed
// in production) are preserved across messages.
const MAX_SESSION_BYTES = 1024 * 1024 * 1024; // 1GB

/**
 * SessionMap wraps a dict-on-disk. Call load() once at startup, then
 * getOrCreate(senderId) per incoming message.
 */
export class SessionMap {
  constructor({ scope = 'telegram' } = {}) {
    this.scope = scope;
    this.sessions = {};
    this.loaded = false;
  }

  load() {
    mkdirSync(FOLA_DIR, { recursive: true });

    if (existsSync(TELEGRAM_SESSIONS_FILE)) {
      try {
        this.sessions = JSON.parse(readFileSync(TELEGRAM_SESSIONS_FILE, 'utf8')) || {};
      } catch {
        this.sessions = {};
      }
    }

    // Migrate legacy single-session file to a special "_shared" entry the
    // first time we boot into multi-session mode. The shared session stays
    // assigned to any caller that doesn't have its own id yet.
    if (this.scope === 'telegram' && existsSync(TELEGRAM_LEGACY_SESSION_FILE)) {
      const legacyId = readFileSync(TELEGRAM_LEGACY_SESSION_FILE, 'utf8').trim();
      if (legacyId && !this.sessions._migrated) {
        this.sessions._legacyShared = legacyId;
        this.sessions._migrated = new Date().toISOString();
        this.persist();
        // Rename the legacy file instead of deleting — keeps an audit trail
        try {
          renameSync(TELEGRAM_LEGACY_SESSION_FILE, `${TELEGRAM_LEGACY_SESSION_FILE}.migrated`);
        } catch {}
      }
    }

    this.loaded = true;
    return this;
  }

  persist() {
    mkdirSync(FOLA_DIR, { recursive: true });
    writeFileSync(TELEGRAM_SESSIONS_FILE, JSON.stringify(this.sessions, null, 2));
  }

  /**
   * Return the session id for senderId, creating one if missing.
   * Auto-rotates if the session file exceeds MAX_SESSION_BYTES (5MB).
   *
   * After calling this, check `this.lastRotation` — if non-null, a rotation
   * just happened and { from, to } tells you which session was retired.
   */
  getOrCreate(senderId) {
    this.lastRotation = null;
    const key = String(senderId);
    if (!this.sessions[key]) {
      this.sessions[key] = randomUUID();
      this.persist();
    }

    // Check if session file is too large → rotate
    if (this.shouldRotate(this.sessions[key])) {
      const oldId = this.sessions[key];
      const newId = randomUUID();
      this.sessions[key] = newId;
      this.lastRotation = { from: oldId, to: newId };
      // Track rotation history
      if (!this.sessions._rotations) this.sessions._rotations = [];
      this.sessions._rotations.push({
        from: oldId,
        to: newId,
        at: new Date().toISOString(),
        reason: 'size_limit',
      });
      // Keep only last 10 rotations
      if (this.sessions._rotations.length > 10) {
        this.sessions._rotations = this.sessions._rotations.slice(-10);
      }
      this.persist();
    }

    return this.sessions[key];
  }

  /**
   * Check if a session file exceeds the size limit.
   */
  shouldRotate(sessionId) {
    try {
      // Session files live at ~/.claude/projects/-Users-ope-Desktop-projects-agent-harness/<id>.jsonl
      const harnessDir = '/Users/ope/Desktop/projects/agent-harness';
      const sanitized = harnessDir.replace(/\//g, '-');
      const sessionFile = join(homedir(), '.claude', 'projects', sanitized, `${sessionId}.jsonl`);
      if (!existsSync(sessionFile)) return false;
      const stat = statSync(sessionFile);
      return stat.size > MAX_SESSION_BYTES;
    } catch {
      return false;
    }
  }

  /**
   * List all known (senderId, sessionId) pairs, excluding metadata keys.
   */
  list() {
    const out = [];
    for (const [k, v] of Object.entries(this.sessions)) {
      if (k.startsWith('_')) continue;
      out.push({ senderId: k, sessionId: v });
    }
    return out;
  }

  /**
   * Reset (start fresh) a sender's session — useful for /reset commands.
   */
  reset(senderId) {
    const key = String(senderId);
    const old = this.sessions[key];
    delete this.sessions[key];
    this.persist();
    return old;
  }

  /**
   * Build a session file path for a given session id.
   */
  sessionFilePath(sessionId) {
    const harnessDir = '/Users/ope/Desktop/projects/agent-harness';
    const sanitized = harnessDir.replace(/\//g, '-');
    return join(homedir(), '.claude', 'projects', sanitized, `${sessionId}.jsonl`);
  }

  /**
   * Extract the last few user/assistant exchanges from an old session JSONL
   * to carry forward as context into a new session. Returns a string block
   * suitable for injecting into a system prompt, or null if nothing useful found.
   *
   * Reads the full file (capped at ~5MB by rotation) and extracts only the
   * text-bearing user and assistant messages.
   */
  getSessionHandoff(oldSessionId, { maxExchanges = 5 } = {}) {
    const filePath = this.sessionFilePath(oldSessionId);
    if (!existsSync(filePath)) return null;

    try {
      const raw = readFileSync(filePath, 'utf8');
      const lines = raw.split('\n');

      const exchanges = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }

        if (entry.type === 'user') {
          // Extract user text — could be a string or array of content blocks
          const content = entry.message?.content;
          let text = '';
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === 'text') text += c.text + '\n';
            }
          }
          if (!text.trim()) continue;
          // Strip the routing/bridge headers — extract just the actual message
          const stripped = stripBridgeHeaders(text);
          if (stripped) {
            exchanges.push({ role: 'user', text: stripped });
          }
        } else if (entry.type === 'assistant') {
          const content = entry.message?.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === 'text' && c.text?.trim()) {
                exchanges.push({ role: 'assistant', text: c.text.trim() });
              }
            }
          }
        }
      }

      // Take the last N exchanges
      const recent = exchanges.slice(-maxExchanges * 2);
      if (recent.length === 0) return null;

      let handoff = '=== PREVIOUS CONVERSATION CONTEXT ===\n';
      handoff += 'Your session was just rotated due to size limits. Below is the tail end of\n';
      handoff += 'the previous conversation so you have continuity. Do NOT re-introduce yourself.\n\n';
      for (const ex of recent) {
        const label = ex.role === 'user' ? 'User' : 'You';
        // Truncate very long messages to keep handoff compact
        const txt = ex.text.length > 500 ? ex.text.slice(0, 500) + '...' : ex.text;
        handoff += `[${label}]: ${txt}\n\n`;
      }
      handoff += '=== END PREVIOUS CONTEXT ===';
      return handoff;
    } catch {
      return null;
    }
  }
}

/**
 * Strip the Telegram bridge routing headers from a prompt, leaving just
 * the user's actual message text.
 */
function stripBridgeHeaders(text) {
  if (!text) return '';
  // Remove the [Incoming Telegram message...] block and REPLY ROUTING block
  let stripped = text
    .replace(/\[Incoming Telegram message[^\]]*\][\s\S]*?=== END REPLY ROUTING ===\s*/g, '')
    .replace(/\[Follow-up message #\d+[^\]]*\]\s*/g, '')
    .trim();
  // Skip if nothing meaningful left
  if (!stripped || stripped.length < 2) return '';
  return stripped;
}
