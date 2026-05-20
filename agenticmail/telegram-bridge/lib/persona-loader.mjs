/**
 * Bridge-side persona resolver.
 *
 * The Telegram bridge shares an identity with the voice runtime and
 * the email worker: there's ONE markdown file at
 * `~/.agenticmail/agents/<name>/persona.md` per agent, and every
 * Claude spawn (Telegram DM reply, phone-call greeting, mailbox
 * worker turn) reads from the same file. The canonical writer is
 * `loadAgentPersona` in @agenticmail/core; this is the bridge's
 * stand-alone copy of the read path, intentionally not importing
 * core so the bridge keeps shipping as a single dependency-light
 * .mjs file.
 *
 * Resolution order:
 *   1. AGENTICMAIL_AGENT_NAME env (explicit override).
 *   2. The single agent under `~/.agenticmail/agents/` if there's
 *      exactly one — the common single-operator case.
 *   3. Empty string ⇒ no persona, bridge runs with Claude's default
 *      voice. The previous behaviour.
 *
 * Best-effort throughout: a missing directory, permission denial,
 * or anything else returns the empty string. The bridge must never
 * crash for a persona-load reason.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const AGENTS_ROOT = join(homedir(), '.agenticmail', 'agents');

/**
 * Resolve the persona body to prepend to claude --append-system-prompt.
 * Empty string when nothing is found (caller should treat as "no
 * persona configured"). Never throws.
 */
export function loadBridgePersona() {
  try {
    const envName = (process.env.AGENTICMAIL_AGENT_NAME || '').trim();
    if (envName) {
      const direct = tryReadPersona(envName);
      if (direct) return direct;
    }
    if (!existsSync(AGENTS_ROOT)) return '';
    const entries = readdirSync(AGENTS_ROOT).filter((n) => {
      try {
        return statSync(join(AGENTS_ROOT, n)).isDirectory();
      } catch {
        return false;
      }
    });
    if (entries.length === 0) return '';
    if (entries.length === 1) {
      const single = tryReadPersona(entries[0]);
      if (single) return single;
    }
    // Multiple agents and no explicit name — bail out rather than
    // pick the wrong one. The operator can set AGENTICMAIL_AGENT_NAME
    // to disambiguate.
    return '';
  } catch {
    return '';
  }
}

function tryReadPersona(name) {
  try {
    // Mirror the filesystem-safe transform the writer uses
    // (core/src/persona/index.ts `personaPathFor`). Keeps alphanums,
    // hyphens, underscores, dots; everything else collapses to '_'.
    const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_');
    const path = join(AGENTS_ROOT, safe, 'persona.md');
    if (!existsSync(path)) return '';
    const content = readFileSync(path, 'utf-8').trim();
    return content;
  } catch {
    return '';
  }
}
