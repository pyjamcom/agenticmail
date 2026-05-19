/**
 * Agent Memory Manager — persistent, evolving per-agent memory.
 *
 * Ported from the AgenticMail Enterprise engine memory system and
 * adapted for the open-source single-tenant package: the multi-tenant
 * `orgId` / organization concepts have been removed (memory here is
 * personal to each agent), the database layer is the built-in
 * `node:sqlite` `Database`, and agent deletion fully purges memory.
 *
 * Each agent gets a growing knowledge store that evolves over time,
 * the way a human employee learns on the job:
 * - Category-based organisation (knowledge, preference, correction,
 *   skill, context, reflection, …).
 * - Importance levels (critical / high / normal / low).
 * - Confidence scores that decay for entries left unaccessed.
 * - Access tracking so frequently-used knowledge ranks higher.
 * - `generateMemoryContext()` — ranks + renders memory as a markdown
 *   block for injection into an agent's prompt (or a voice session).
 * - Pruning of expired / low-confidence entries.
 *
 * Design: an in-memory `Map` + BM25F search index fronts the
 * `agent_memory` SQLite table. Reads hit memory; writes update both.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../storage/db.js';
import { MemorySearchIndex } from './text-search.js';

function sj(v: string | null | undefined, fb: any = {}): any {
  if (!v) return fb;
  try { return JSON.parse(v); } catch { return fb; }
}

// ─── Types ──────────────────────────────────────────────

export type MemoryCategory =
  | 'knowledge'
  | 'interaction_pattern'
  | 'preference'
  | 'correction'
  | 'skill'
  | 'context'
  | 'reflection'
  | 'session_learning'
  | 'system_notice';

export type MemoryImportance = 'critical' | 'high' | 'normal' | 'low';

export type MemorySource =
  | 'interaction'
  | 'self_reflection'
  | 'correction'
  | 'system'
  | 'context_compaction'
  | 'transfer';

export const MEMORY_CATEGORIES: Record<MemoryCategory, { label: string; description: string }> = {
  knowledge: {
    label: 'Knowledge',
    description: 'Facts, procedures, and reference information the agent has learned',
  },
  interaction_pattern: {
    label: 'Interaction Patterns',
    description: 'Learned patterns from past interactions',
  },
  preference: {
    label: 'Preferences',
    description: 'User and counterparty preferences',
  },
  correction: {
    label: 'Corrections',
    description: 'Corrections and feedback received',
  },
  skill: {
    label: 'Skills',
    description: 'Learned abilities and competencies',
  },
  context: {
    label: 'Context',
    description: 'Contextual information and background knowledge',
  },
  reflection: {
    label: 'Reflections',
    description: 'Self-reflective insights and learnings',
  },
  session_learning: {
    label: 'Session Learnings',
    description: 'Insights captured during conversation sessions',
  },
  system_notice: {
    label: 'System Notices',
    description: 'System-generated notifications about configuration changes',
  },
};

const VALID_CATEGORIES = new Set(Object.keys(MEMORY_CATEGORIES));
const VALID_IMPORTANCE = new Set<MemoryImportance>(['critical', 'high', 'normal', 'low']);

export interface AgentMemoryEntry {
  id: string;
  agentId: string;
  category: MemoryCategory;
  title: string;
  content: string;
  source: MemorySource;
  importance: MemoryImportance;
  confidence: number; // 0.0-1.0
  accessCount: number;
  lastAccessedAt?: string;
  expiresAt?: string;
  tags: string[];
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryStats {
  totalEntries: number;
  byCategory: Record<string, number>;
  byImportance: Record<string, number>;
  bySource: Record<string, number>;
  avgConfidence: number;
}

/** Input shape for createMemory — id, timestamps, accessCount, and some fields have defaults. */
export type CreateMemoryInput = Omit<AgentMemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'confidence' | 'tags' | 'metadata' | 'lastAccessedAt' | 'expiresAt'> & {
  confidence?: number;
  tags?: string[];
  metadata?: Record<string, any>;
  lastAccessedAt?: string;
  expiresAt?: string;
};

/** Input shape for updateMemory — partial updates merged with existing entry. */
export type UpdateMemoryInput = Partial<Omit<AgentMemoryEntry, 'id' | 'agentId' | 'createdAt'>>;

/** Query options for filtering memory entries. */
export interface MemoryQueryOptions {
  agentId: string;
  category?: string;
  importance?: string;
  source?: string;
  query?: string;
  limit?: number;
}

// ─── Importance Weight Map ──────────────────────────────

const IMPORTANCE_WEIGHT: Record<MemoryImportance, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

// ─── Agent Memory Manager ───────────────────────────────

export class AgentMemoryManager {
  private memories = new Map<string, AgentMemoryEntry>();
  /** Per-agent index: agentId → Set of memory IDs for O(1) agent lookups */
  private agentIndex = new Map<string, Set<string>>();
  /** Full-text search index (BM25F + stemming + inverted index) */
  private searchIndex = new MemorySearchIndex();
  private initialized = false;

  constructor(private db: Database) {
    this.ensureTable();
    this.loadFromDb();
  }

  // ─── Database layer ─────────────────────────────────

  private ensureTable(): void {
    if (this.initialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'interaction',
        importance TEXT NOT NULL DEFAULT 'normal',
        confidence REAL NOT NULL DEFAULT 1.0,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        expires_at TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id)'); } catch { /* ignore */ }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_agent_memory_category ON agent_memory(category)'); } catch { /* ignore */ }
    this.initialized = true;
  }

  /** Run a write statement, swallowing errors with a log (memory must never crash a caller). */
  private dbRun(sql: string, params: unknown[]): void {
    try {
      this.db.prepare(sql).run(...(params as any[]));
    } catch (err) {
      console.error('[agent-memory] DB write failed:', (err as Error).message);
    }
  }

  private dbAll(sql: string, params: unknown[] = []): any[] {
    try {
      return this.db.prepare(sql).all(...(params as any[])) as any[];
    } catch (err) {
      console.error('[agent-memory] DB read failed:', (err as Error).message);
      return [];
    }
  }

  private loadFromDb(): void {
    const rows = this.dbAll('SELECT * FROM agent_memory');
    for (const r of rows) {
      try {
        const entry = this.rowToEntry(r);
        this.memories.set(entry.id, entry);
        this.indexAdd(entry.agentId, entry.id);
        this.searchIndex.addDocument(entry.id, entry);
      } catch { /* skip malformed row */ }
    }
  }

  /** Add a memory ID to the per-agent index. */
  private indexAdd(agentId: string, memoryId: string): void {
    let set = this.agentIndex.get(agentId);
    if (!set) { set = new Set(); this.agentIndex.set(agentId, set); }
    set.add(memoryId);
  }

  /** Remove a memory ID from the per-agent index. */
  private indexRemove(agentId: string, memoryId: string): void {
    const set = this.agentIndex.get(agentId);
    if (set) { set.delete(memoryId); if (set.size === 0) this.agentIndex.delete(agentId); }
  }

  /** Get all memory entries for an agent via the index. */
  private getAgentMemories(agentId: string): AgentMemoryEntry[] {
    const ids = this.agentIndex.get(agentId);
    if (!ids || ids.size === 0) return [];
    const result: AgentMemoryEntry[] = [];
    for (const id of ids) {
      const entry = this.memories.get(id);
      if (entry) result.push(entry);
    }
    return result;
  }

  // ─── Convenience Methods ─────────────────────────────

  /** Store a memory with minimal input — the common "just remember this" case. */
  async storeMemory(agentId: string, opts: {
    content: string;
    category?: string;
    importance?: string;
    confidence?: number;
    title?: string;
    tags?: string[];
  }): Promise<AgentMemoryEntry> {
    const category = (opts.category && VALID_CATEGORIES.has(opts.category) ? opts.category : 'context') as MemoryCategory;
    const importance = (opts.importance && VALID_IMPORTANCE.has(opts.importance as MemoryImportance)
      ? opts.importance : 'normal') as MemoryImportance;
    return this.createMemory({
      agentId,
      content: opts.content,
      category,
      importance,
      confidence: opts.confidence ?? 1.0,
      title: opts.title || opts.content.slice(0, 80),
      source: 'system',
      tags: opts.tags ?? [],
      metadata: {},
    });
  }

  /** Search memories by text query, sorted by relevance. */
  async recall(agentId: string, query: string, limit: number = 5): Promise<AgentMemoryEntry[]> {
    return this.queryMemories({ agentId, query, limit });
  }

  // ─── CRUD Operations ────────────────────────────────

  /** Create a new memory entry with auto-generated id + timestamps. */
  async createMemory(input: CreateMemoryInput): Promise<AgentMemoryEntry> {
    const now = new Date().toISOString();
    const entry: AgentMemoryEntry = {
      ...input,
      confidence: input.confidence ?? 0.8,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
      id: randomUUID(),
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.memories.set(entry.id, entry);
    this.indexAdd(entry.agentId, entry.id);
    this.searchIndex.addDocument(entry.id, entry);

    this.dbRun(
      `INSERT INTO agent_memory (id, agent_id, category, title, content, source, importance, confidence, access_count, last_accessed_at, expires_at, tags, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id, entry.agentId, entry.category, entry.title, entry.content,
        entry.source, entry.importance, entry.confidence, entry.accessCount,
        entry.lastAccessedAt || null, entry.expiresAt || null,
        JSON.stringify(entry.tags), JSON.stringify(entry.metadata),
        entry.createdAt, entry.updatedAt,
      ],
    );

    return entry;
  }

  /** Update an existing memory entry by merging provided fields. */
  async updateMemory(id: string, updates: UpdateMemoryInput): Promise<AgentMemoryEntry | null> {
    const existing = this.memories.get(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updated: AgentMemoryEntry = {
      ...existing,
      ...updates,
      id: existing.id,
      agentId: existing.agentId,
      createdAt: existing.createdAt,
      updatedAt: now,
    };

    this.memories.set(id, updated);

    if (updates.title !== undefined || updates.content !== undefined || updates.tags !== undefined) {
      this.searchIndex.addDocument(id, updated);
    }

    this.dbRun(
      `UPDATE agent_memory SET
        category = ?, title = ?, content = ?, source = ?,
        importance = ?, confidence = ?, access_count = ?,
        last_accessed_at = ?, expires_at = ?, tags = ?,
        metadata = ?, updated_at = ?
       WHERE id = ?`,
      [
        updated.category, updated.title, updated.content, updated.source,
        updated.importance, updated.confidence, updated.accessCount,
        updated.lastAccessedAt || null, updated.expiresAt || null,
        JSON.stringify(updated.tags), JSON.stringify(updated.metadata),
        updated.updatedAt, id,
      ],
    );

    return updated;
  }

  /** Delete a single memory entry. Returns true if it existed. */
  async deleteMemory(id: string): Promise<boolean> {
    const entry = this.memories.get(id);
    const existed = this.memories.delete(id);
    if (entry) this.indexRemove(entry.agentId, id);
    this.searchIndex.removeDocument(id);
    this.dbRun('DELETE FROM agent_memory WHERE id = ?', [id]);
    return existed;
  }

  /**
   * Purge every memory entry belonging to an agent — Map, per-agent
   * index, search index, and the database row. Called when an agent is
   * deleted so no orphaned memory is left behind.
   * Returns the number of entries removed.
   */
  async deleteAgentMemories(agentId: string): Promise<number> {
    const ids = Array.from(this.agentIndex.get(agentId) ?? []);
    for (const id of ids) {
      this.memories.delete(id);
      this.searchIndex.removeDocument(id);
    }
    this.agentIndex.delete(agentId);
    this.dbRun('DELETE FROM agent_memory WHERE agent_id = ?', [agentId]);
    return ids.length;
  }

  /** Retrieve a single memory entry by id. */
  async getMemory(id: string): Promise<AgentMemoryEntry | undefined> {
    return this.memories.get(id);
  }

  // ─── Query Operations ───────────────────────────────

  /** Query an agent's memory with optional category/importance/source filters + text search. */
  async queryMemories(opts: MemoryQueryOptions): Promise<AgentMemoryEntry[]> {
    let results = this.getAgentMemories(opts.agentId);

    if (opts.category) results = results.filter((m) => m.category === opts.category);
    if (opts.importance) results = results.filter((m) => m.importance === opts.importance);
    if (opts.source) results = results.filter((m) => m.source === opts.source);

    if (opts.query) {
      const candidateIds = new Set(results.map((m) => m.id));
      const searchResults = this.searchIndex.search(opts.query, candidateIds);
      if (searchResults.length > 0) {
        const scored = searchResults
          .map((r) => {
            const entry = this.memories.get(r.id);
            return entry ? { entry, score: r.score * IMPORTANCE_WEIGHT[entry.importance] } : null;
          })
          .filter((r): r is { entry: AgentMemoryEntry; score: number } => r !== null);
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, opts.limit || 100).map((d) => d.entry);
      }
      return [];
    }

    results.sort((a, b) => {
      const weightDiff = IMPORTANCE_WEIGHT[b.importance] - IMPORTANCE_WEIGHT[a.importance];
      if (weightDiff !== 0) return weightDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return results.slice(0, opts.limit || 100);
  }

  /** Memories created within the last N hours for an agent. */
  async getRecentMemories(agentId: string, hours: number = 24): Promise<AgentMemoryEntry[]> {
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    return this.getAgentMemories(agentId)
      .filter((m) => m.createdAt >= cutoff)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // ─── Access Tracking ────────────────────────────────

  /** Bump access count + lastAccessedAt for a memory entry. */
  async recordAccess(memoryId: string): Promise<void> {
    const entry = this.memories.get(memoryId);
    if (!entry) return;
    const now = new Date().toISOString();
    entry.accessCount += 1;
    entry.lastAccessedAt = now;
    entry.updatedAt = now;
    this.dbRun(
      'UPDATE agent_memory SET access_count = ?, last_accessed_at = ?, updated_at = ? WHERE id = ?',
      [entry.accessCount, entry.lastAccessedAt, entry.updatedAt, memoryId],
    );
  }

  // ─── Context Generation ─────────────────────────────

  /**
   * Render an agent's memory as a markdown block for prompt injection.
   * Ranks entries by confidence × access × recency × importance, with a
   * BM25F relevance boost when a query is supplied, groups by category,
   * and truncates to ~maxTokens (estimated at 4 chars/token).
   */
  async generateMemoryContext(agentId: string, query?: string, maxTokens: number = 1500): Promise<string> {
    const entries = this.getAgentMemories(agentId).filter((m) => m.confidence >= 0.1);
    if (entries.length === 0) return '';

    const now = Date.now();

    let relevanceMap: Map<string, number> | undefined;
    if (query) {
      const candidateIds = new Set(entries.map((e) => e.id));
      const searchResults = this.searchIndex.search(query, candidateIds);
      if (searchResults.length > 0) {
        relevanceMap = new Map();
        const maxScore = searchResults[0].score;
        for (const r of searchResults) {
          relevanceMap.set(r.id, maxScore > 0 ? r.score / maxScore : 0);
        }
      }
    }

    const scored = entries.map((entry) => {
      const accessWeight = 1 + Math.log1p(entry.accessCount) * 0.3;
      const lastTouch = entry.lastAccessedAt || entry.createdAt;
      const ageHours = Math.max(1, (now - new Date(lastTouch).getTime()) / 3600_000);
      const recencyWeight = 1 / (1 + Math.log1p(ageHours / 24) * 0.2);
      let score = entry.confidence * accessWeight * recencyWeight;
      score *= IMPORTANCE_WEIGHT[entry.importance];
      if (relevanceMap) {
        const relevance = relevanceMap.get(entry.id) || 0;
        if (relevance > 0) score *= 1 + relevance * 3;
      }
      return { entry, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const grouped = new Map<MemoryCategory, AgentMemoryEntry[]>();
    for (const { entry } of scored) {
      const group = grouped.get(entry.category) || [];
      group.push(entry);
      grouped.set(entry.category, group);
    }

    const maxChars = maxTokens * 4;
    const lines: string[] = ['## Agent Memory', ''];
    let charCount = lines.join('\n').length;

    for (const [category, categoryEntries] of Array.from(grouped.entries())) {
      const meta = MEMORY_CATEGORIES[category];
      if (!meta) continue;
      const header = `### ${meta.label}`;
      if (charCount + header.length + 2 > maxChars) break;
      lines.push(header, '');
      charCount += header.length + 2;
      for (const entry of categoryEntries) {
        const badge = entry.importance === 'critical' ? '[CRITICAL] '
          : entry.importance === 'high' ? '[HIGH] '
          : '';
        const entryLine = `- **${badge}${entry.title}**: ${entry.content}`;
        if (charCount + entryLine.length + 1 > maxChars) break;
        lines.push(entryLine);
        charCount += entryLine.length + 1;
      }
      lines.push('');
      charCount += 1;
    }

    return lines.join('\n').trim();
  }

  // ─── Memory Lifecycle ───────────────────────────────

  /** Decay confidence for entries unaccessed for 7+ days. Critical entries are exempt. */
  async decayConfidence(agentId: string, decayRate: number = 0.05): Promise<number> {
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const now = new Date().toISOString();
    let decayed = 0;

    for (const entry of this.getAgentMemories(agentId)) {
      if (entry.importance === 'critical') continue;
      const lastTouch = entry.lastAccessedAt || entry.createdAt;
      if (lastTouch >= cutoff) continue;
      const newConfidence = Math.max(0, entry.confidence - decayRate);
      if (newConfidence === entry.confidence) continue;
      entry.confidence = parseFloat(newConfidence.toFixed(4));
      entry.updatedAt = now;
      this.dbRun('UPDATE agent_memory SET confidence = ?, updated_at = ? WHERE id = ?',
        [entry.confidence, now, entry.id]);
      decayed += 1;
    }
    return decayed;
  }

  /** Prune entries with confidence < 0.1 or past their expiresAt. */
  async pruneExpired(agentId?: string): Promise<number> {
    const now = new Date().toISOString();
    const toDelete: { id: string; agentId: string }[] = [];

    const entries = agentId
      ? this.getAgentMemories(agentId)
      : Array.from(this.memories.values());

    for (const entry of entries) {
      const isLowConfidence = entry.confidence < 0.1;
      const isExpired = !!entry.expiresAt && entry.expiresAt <= now;
      if (isLowConfidence || isExpired) toDelete.push({ id: entry.id, agentId: entry.agentId });
    }

    for (const item of toDelete) {
      this.memories.delete(item.id);
      this.indexRemove(item.agentId, item.id);
      this.searchIndex.removeDocument(item.id);
      this.dbRun('DELETE FROM agent_memory WHERE id = ?', [item.id]);
    }

    return toDelete.length;
  }

  // ─── Statistics ─────────────────────────────────────

  /** Aggregate statistics for a specific agent's memory. */
  async getStats(agentId: string): Promise<MemoryStats> {
    return this.computeStats(this.getAgentMemories(agentId));
  }

  private computeStats(entries: AgentMemoryEntry[]): MemoryStats {
    const byCategory: Record<string, number> = {};
    const byImportance: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let totalConfidence = 0;

    for (const entry of entries) {
      byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
      byImportance[entry.importance] = (byImportance[entry.importance] || 0) + 1;
      bySource[entry.source] = (bySource[entry.source] || 0) + 1;
      totalConfidence += entry.confidence;
    }

    return {
      totalEntries: entries.length,
      byCategory,
      byImportance,
      bySource,
      avgConfidence: entries.length > 0
        ? parseFloat((totalConfidence / entries.length).toFixed(4))
        : 0,
    };
  }

  // ─── Row Mapper ─────────────────────────────────────

  private rowToEntry(row: any): AgentMemoryEntry {
    return {
      id: row.id,
      agentId: row.agent_id,
      category: row.category as MemoryCategory,
      title: row.title,
      content: row.content,
      source: row.source as MemorySource,
      importance: row.importance as MemoryImportance,
      confidence: row.confidence,
      accessCount: row.access_count || 0,
      lastAccessedAt: row.last_accessed_at || undefined,
      expiresAt: row.expires_at || undefined,
      tags: Array.isArray(sj(row.tags)) ? sj(row.tags) : [],
      metadata: sj(row.metadata || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
