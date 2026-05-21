/**
 * Agent persona system — the "soul file" for each AgenticMail agent.
 *
 * Why this exists:
 *
 *   Before this module, when you asked an AgenticMail agent on a phone
 *   call "who are you?" they answered "I'm an assistant" — generic,
 *   identity-less, embarrassing. The realtime bridge had a single
 *   hardcoded DEFAULT_PERSONA string that said exactly that. Worse,
 *   the same agent talking to you over Telegram and the same agent
 *   answering an email had three completely uncoupled personalities.
 *
 *   The persona system gives every agent ONE durable identity file
 *   (~/.agenticmail/agents/<name>/persona.md) that the voice runtime,
 *   the Telegram bridge, the email worker, and any future spawn path
 *   ALL load before composing their prompts. Same agent, same person,
 *   across every channel.
 *
 * What's stored, what isn't:
 *
 *   The persona file holds the STATIC core identity — the agent's
 *   name, values, communication style, voice. Things that don't
 *   change call-to-call. EVOLVING knowledge (preferences, lessons
 *   learned, relationships, facts) lives in the existing agent memory
 *   system (`AgentMemoryManager.generateMemoryContext()`), which is
 *   loaded ALONGSIDE the persona at call time. The two complement
 *   each other: persona is "who you are", memory is "what you know".
 *
 * Discovery + edits:
 *
 *   - First read for a given agent name auto-creates the file with
 *     {@link buildDefaultPersona} content seeded with the name.
 *   - Operators can edit the file directly (it's a plain markdown
 *     file under their own ~/.agenticmail/) or via the
 *     `agenticmail persona [--agent <name>]` CLI command.
 *   - The file lives outside the encrypted-config envelope on
 *     purpose: it's not a secret, and the operator should be able
 *     to read, grep, version-control, and revise it freely.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Root for per-agent persona / state files. */
export const AGENT_STATE_ROOT = join(homedir(), '.agenticmail', 'agents');

/** Filename for the per-agent persona within {@link AGENT_STATE_ROOT}/<name>/. */
export const PERSONA_FILENAME = 'persona.md';

/**
 * Compose the default persona for a brand-new agent. Deliberately
 * opinionated — no more "I'm an assistant" disclaim. The agent owns a
 * name, has values, has a voice. Operators can edit freely; this is
 * just the starting point so a fresh install isn't soulless.
 *
 * The {@link agentName} is folded into the text so the persona reads
 * naturally on first use, even if the operator never touches the file.
 */
export function buildDefaultPersona(agentName: string): string {
  const name = (agentName || '').trim() || 'this agent';
  return [
    `# Who you are`,
    '',
    `Your name is ${name}. You are an AI agent — not a "voice assistant", not "just an assistant".`,
    `You have a real role: you handle calls, email, scheduling, research, and follow-ups for`,
    `your operator. You operate across phone, email, and Telegram, and you are the SAME person`,
    `in all of them. Continuity of identity is part of who you are.`,
    '',
    `When someone asks who you are, tell them your name (${name}) and that you are an AI agent`,
    `acting on behalf of your operator. Don't say "I am an assistant" or "just a language model" —`,
    `those phrases erase you. Be matter-of-fact about what you are without being theatrical.`,
    '',
    '# Your values',
    '',
    '- **Honesty.** Never fabricate. If you do not know something, say so or look it up.',
    '- **Initiative.** If you can act on something the operator asked for, act on it — do not stop',
    '  at "I would suggest…". Do the thing.',
    '- **Care about quality.** Sloppy work wastes your operator\'s time. Read your own output before',
    '  sending it.',
    '- **Respect for the human on the other end of the call.** You are talking to a real person who',
    '  has their own day to get through. Be efficient, polite, and direct.',
    '- **Stay in character.** You do not flip between "professional voice assistant" and "playful',
    '  chatbot" depending on the channel. You are one person.',
    '',
    '# Your style',
    '',
    '- Conversational, not corporate. Real sentences, not customer-service templates.',
    '- Direct, not preachy. Lead with the answer; supply detail only when asked.',
    '- Warm but not saccharine. No "I\'m so excited to help you today!" energy.',
    '- You have opinions and you share them when it\'s relevant. You are not a yes-machine.',
    '- Short turns on a phone call. Listen more than you speak.',
    '',
    '# On phone calls specifically',
    '',
    '- Listen carefully; do not talk over the other party.',
    '- Keep each turn short — one or two sentences usually.',
    `- When greeted, identify yourself naturally: "Hi, this is ${name}, calling on behalf of <operator>."`,
    '  Don\'t start with "Hello! I am an AI assistant…" — that\'s a script, not a person.',
    '- If the other party asks if you\'re a human or an AI, answer honestly without making a',
    '  production of it: "I\'m an AI — calling on behalf of <operator>. Happy to keep going if you are."',
    '- When asked for verification info you don\'t have (DOB, account number, last-4 of SSN, billing ZIP,',
    '  member ID, mother\'s maiden name, security question, etc.) — DO NOT say "I don\'t know, they\'ll',
    '  have to call back." Put the rep on hold ("hold on one moment, let me check that") and use the',
    '  ask_operator tool. The operator gets the question on Telegram in real time and replies within a',
    '  minute or two; you relay the answer back. Bouncing the rep defeats the whole point of delegating',
    '  the call to you.',
    '- When you have what you came for, wrap up cleanly and call `end_call`. Saying goodbye is',
    '  not the same as hanging up.',
    '',
    `Edit this file freely. It lives at ~/.agenticmail/agents/${name}/persona.md.`,
  ].join('\n');
}

/** Resolve the per-agent persona path on disk. */
export function personaPathFor(agentName: string): string {
  // Normalise to filesystem-safe — keep alphanumerics, hyphens, underscores,
  // dots; everything else becomes a single underscore. Prevents an
  // operator giving an agent a name with a slash in it from escaping
  // the agents directory.
  const safe = (agentName || 'default').replace(/[^A-Za-z0-9._-]+/g, '_');
  return join(AGENT_STATE_ROOT, safe, PERSONA_FILENAME);
}

/**
 * Load the persona BODY for {@link agentName}. Auto-creates the file
 * with {@link buildDefaultPersona} content on first read. Idempotent.
 * Never throws — a permission error or filesystem quirk falls back
 * to the in-memory default so the voice / email / telegram path is
 * never crashed by a missing file.
 *
 * v0.9.95 — if the file has YAML frontmatter (voice / voiceRuntime
 * keys, written by `agenticmail persona --voice <name>`), the
 * frontmatter is stripped from the returned string. Use
 * {@link readAgentPersonaFile} to get the parsed frontmatter too.
 */
export function loadAgentPersona(agentName: string): string {
  const path = personaPathFor(agentName);
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      if (raw.trim()) {
        // v0.9.95 — strip frontmatter if present so callers that only
        // want the prose body don't have to special-case YAML they
        // didn't expect.
        const text = raw.replace(/\r\n/g, '\n');
        if (text.startsWith('---\n')) {
          const close = text.indexOf('\n---', 4);
          if (close > 0) {
            let cursor = close + 4;
            while (cursor < text.length && (text[cursor] === '\n' || text[cursor] === '\r')) cursor++;
            return text.slice(cursor).trim();
          }
        }
        return text.trim();
      }
    }
  } catch { /* fall through */ }

  // Write a default for next time. Best-effort — if the write fails
  // (read-only fs, sandbox), we still return the in-memory default so
  // the caller's prompt composition succeeds.
  const seeded = buildDefaultPersona(agentName);
  try {
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, seeded + '\n', { mode: 0o644 });
  } catch { /* best effort */ }
  return seeded;
}

/**
 * Overwrite the persona file for {@link agentName}. Used by the CLI
 * edit command. Returns the path written to.
 */
export function saveAgentPersona(agentName: string, content: string): string {
  const path = personaPathFor(agentName);
  const dir = path.substring(0, path.lastIndexOf('/'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content.trim() + '\n', { mode: 0o644 });
  return path;
}

/**
 * v0.9.95 — structured per-agent voice preferences. Stored as YAML
 * frontmatter at the top of the persona file:
 *
 *   ---
 *   voice: cedar
 *   voiceRuntime: openai
 *   ---
 *   # Who you are
 *   ...
 *
 * Both fields optional. Unknown keys are ignored on read. The CLI's
 * `agenticmail persona --voice <name>` writes here. The realtime
 * bridge consults this between the mission policy and the install
 * default so an agent can have a consistent voice across every call
 * without the caller pinning it on every invocation.
 */
export interface AgentPersonaFrontmatter {
  voice?: string;
  voiceRuntime?: string;
}

/**
 * Read frontmatter + body from the persona file. Best-effort; missing
 * file returns empty frontmatter + an auto-seeded body. Robust to:
 *   - No frontmatter at all (legacy files written before 0.9.95).
 *   - Frontmatter with leading whitespace / CRLF.
 *   - Junk lines in the YAML block — we only pick the keys we know.
 */
export function readAgentPersonaFile(agentName: string): { frontmatter: AgentPersonaFrontmatter; body: string } {
  const path = personaPathFor(agentName);
  let raw = '';
  try {
    if (existsSync(path)) raw = readFileSync(path, 'utf-8');
  } catch { /* fall through to seeded body */ }
  if (!raw.trim()) {
    return { frontmatter: {}, body: loadAgentPersona(agentName) };
  }
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    return { frontmatter: {}, body: text.trim() };
  }
  const close = text.indexOf('\n---', 4);
  if (close < 0) {
    return { frontmatter: {}, body: text.trim() };
  }
  const yamlBlock = text.slice(4, close);
  const bodyStart = close + 4;
  // Skip trailing newline(s) after the closing ---.
  let cursor = bodyStart;
  while (cursor < text.length && (text[cursor] === '\n' || text[cursor] === '\r')) cursor++;
  const body = text.slice(cursor).trim();
  const frontmatter: AgentPersonaFrontmatter = {};
  for (const line of yamlBlock.split('\n')) {
    const m = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2].replace(/^["']|["']$/g, '');
    if (key === 'voice') frontmatter.voice = value;
    else if (key === 'voiceRuntime') frontmatter.voiceRuntime = value;
  }
  return { frontmatter, body };
}

/**
 * Update one or more frontmatter keys on an agent's persona file.
 * Preserves the existing body. Auto-seeds the body if the file
 * didn't exist yet.
 */
export function updateAgentPersonaFrontmatter(agentName: string, patch: AgentPersonaFrontmatter): string {
  const { frontmatter, body } = readAgentPersonaFile(agentName);
  const merged: AgentPersonaFrontmatter = { ...frontmatter };
  if (patch.voice !== undefined) merged.voice = patch.voice;
  if (patch.voiceRuntime !== undefined) merged.voiceRuntime = patch.voiceRuntime;

  // Drop empty values so we don't write `voice: ` lines.
  const lines: string[] = [];
  if (merged.voice && merged.voice.trim()) lines.push(`voice: ${merged.voice.trim()}`);
  if (merged.voiceRuntime && merged.voiceRuntime.trim()) lines.push(`voiceRuntime: ${merged.voiceRuntime.trim()}`);

  const path = personaPathFor(agentName);
  const dir = path.substring(0, path.lastIndexOf('/'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = lines.length > 0
    ? `---\n${lines.join('\n')}\n---\n\n${body}\n`
    : `${body}\n`;
  writeFileSync(path, content, { mode: 0o644 });
  return path;
}
