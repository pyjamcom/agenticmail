/**
 * Per-agent thread memory — Layer 2 of the wake-context system.
 *
 * # What it stores
 *
 * Each `(agent, thread)` tuple gets a tiny markdown file
 * the AGENT writes at the end of its wake. The dispatcher
 * doesn't write this — it's the agent's own narrative about
 * what THEY committed to, what's open, and the last action
 * they took on the thread.
 *
 * # Why it's separate from the ThreadCache
 *
 * The cache is FACTS (whoever sent what when). The memory is
 * JUDGMENT (what does each agent intend to do about it). Two
 * agents on the same thread share the cache verbatim but each
 * has their own memory file; what Vesper thinks she committed
 * to is none of Orion's business.
 *
 * # Disk layout
 *
 *   ~/.agenticmail/agent-memory/<agentId>/<threadId>.md
 *
 * The path is hierarchical (per-agent dir) so cleanup on agent
 * deletion is `rm -rf <agentDir>` and concurrent writers don't
 * step on each other across agents.
 *
 * # Format
 *
 * Tiny YAML frontmatter for structured fields the dispatcher
 * cares about (`updated_at`, `lastUid`); free-form markdown
 * body for the agent's prose. The agent passes these as
 * separate fields on the MCP tool and we render the file
 * deterministically — no Markdown-in-YAML parsing nightmare.
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  rmSync, renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MEMORY_DIR_DEFAULT = join(homedir(), '.agenticmail', 'agent-memory');

export interface AgentMemoryFields {
  /** One-paragraph narrative of where the thread stands. */
  summary?: string;
  /** Things THIS agent has committed to doing. */
  commitments?: string[];
  /** Things THIS agent is waiting on / open questions. */
  openQuestions?: string[];
  /** Last action this agent took on the thread (e.g. "replied UID 41 asking for the raw counts"). */
  lastAction?: string;
  /** Last message UID this agent has digested. Used as a cursor
   *  to detect "memory is older than the cache" on the dispatcher
   *  side. */
  lastUid?: number;
}

export interface AgentMemoryRead extends AgentMemoryFields {
  /** ISO timestamp of the most recent write. */
  updatedAt?: string;
  /** Raw file contents — useful for the wake prompt; rendered
   *  verbatim into the "Your own memory" block. */
  raw: string;
}

export interface AgentMemoryOptions {
  memoryDir?: string;
}

export class AgentMemoryStore {
  private readonly dir: string;

  constructor(opts: AgentMemoryOptions = {}) {
    this.dir = opts.memoryDir ?? MEMORY_DIR_DEFAULT;
    try { mkdirSync(this.dir, { recursive: true }); } catch { /* ignore */ }
  }

  private dirFor(agentId: string): string {
    return join(this.dir, sanitizeId(agentId));
  }

  private pathFor(agentId: string, threadId: string): string {
    return join(this.dirFor(agentId), `${sanitizeId(threadId)}.md`);
  }

  read(agentId: string, threadId: string): AgentMemoryRead | null {
    const p = this.pathFor(agentId, threadId);
    if (!existsSync(p)) return null;
    try {
      const raw = readFileSync(p, 'utf-8');
      const parsed = parse(raw);
      return { ...parsed, raw };
    } catch {
      return null;
    }
  }

  write(agentId: string, threadId: string, fields: AgentMemoryFields): void {
    const agentDir = this.dirFor(agentId);
    try { mkdirSync(agentDir, { recursive: true }); } catch { /* ignore */ }
    const body = render({ ...fields, updatedAt: new Date().toISOString() });
    const p = this.pathFor(agentId, threadId);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, body, 'utf-8');
    renameSync(tmp, p);
  }

  delete(agentId: string, threadId: string): void {
    try { rmSync(this.pathFor(agentId, threadId), { force: true }); } catch { /* ignore */ }
  }

  /** Render an agent's memory for injection into a wake prompt.
   *  Returns the raw markdown if present; empty string when there's
   *  no prior memory (the caller decides whether to suppress the
   *  whole "Your own memory" block). */
  renderForPrompt(memory: AgentMemoryRead | null): string {
    if (!memory) return '';
    return memory.raw;
  }
}

/** Replace anything outside [a-zA-Z0-9._-] with `_` so the id
 *  is safe as a filesystem path component on every OS. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function render(fields: AgentMemoryFields & { updatedAt: string }): string {
  const fm: string[] = ['---'];
  fm.push(`updated_at: ${fields.updatedAt}`);
  if (typeof fields.lastUid === 'number') fm.push(`last_uid: ${fields.lastUid}`);
  fm.push('---', '');

  const sections: string[] = [];
  if (fields.summary && fields.summary.trim()) {
    sections.push(fields.summary.trim());
  }
  if (fields.commitments && fields.commitments.length > 0) {
    sections.push(`### Commitments\n${fields.commitments.map(c => `- ${c}`).join('\n')}`);
  }
  if (fields.openQuestions && fields.openQuestions.length > 0) {
    sections.push(`### Open\n${fields.openQuestions.map(q => `- ${q}`).join('\n')}`);
  }
  if (fields.lastAction && fields.lastAction.trim()) {
    sections.push(`### Last action\n${fields.lastAction.trim()}`);
  }

  return fm.join('\n') + sections.join('\n\n') + '\n';
}

function parse(raw: string): AgentMemoryFields & { updatedAt?: string } {
  const out: AgentMemoryFields & { updatedAt?: string } = {};
  // Frontmatter is a leading `---` block; parse just the two keys
  // we care about and ignore the rest.
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      if (kv[1] === 'updated_at') out.updatedAt = kv[2].trim();
      else if (kv[1] === 'last_uid') {
        const n = parseInt(kv[2], 10);
        if (!isNaN(n)) out.lastUid = n;
      }
    }
  }
  return out;
}
