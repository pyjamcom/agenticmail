import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../storage/db.js';
import { AgentMemoryManager } from '../memory/index.js';

function freshManager() {
  const db = createTestDatabase();
  return { db, manager: new AgentMemoryManager(db) };
}

describe('AgentMemoryManager', () => {
  it('stores and recalls a memory by text search', async () => {
    const { manager } = freshManager();
    await manager.storeMemory('agent1', {
      content: 'The operator prefers terse, direct status updates.',
      category: 'preference',
      title: 'Status update style',
    });
    await manager.storeMemory('agent1', {
      content: 'Restaurant reservations should default to a window seat.',
      category: 'preference',
      title: 'Reservation seating',
    });

    const hits = await manager.recall('agent1', 'reservation seating preference');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toBe('Reservation seating');
  });

  it('scopes memory per agent — one agent never sees another agent memory', async () => {
    const { manager } = freshManager();
    await manager.storeMemory('agent1', { content: 'Agent 1 private note', title: 'A1' });
    await manager.storeMemory('agent2', { content: 'Agent 2 private note', title: 'A2' });

    const a1 = await manager.queryMemories({ agentId: 'agent1' });
    const a2 = await manager.queryMemories({ agentId: 'agent2' });
    expect(a1.map((m) => m.title)).toEqual(['A1']);
    expect(a2.map((m) => m.title)).toEqual(['A2']);
  });

  it('persists to the agent_memory table and reloads on a fresh manager', async () => {
    const { db, manager } = freshManager();
    await manager.storeMemory('agent1', { content: 'Durable fact', title: 'Durable', importance: 'high' });

    const raw = db.prepare('SELECT COUNT(*) AS n FROM agent_memory WHERE agent_id = ?').get('agent1') as { n: number };
    expect(raw.n).toBe(1);

    // A new manager over the same DB reloads the entry from disk.
    const reloaded = new AgentMemoryManager(db);
    const hits = await reloaded.queryMemories({ agentId: 'agent1' });
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toBe('Durable fact');
  });

  it('generates a markdown memory-context block for prompt injection', async () => {
    const { manager } = freshManager();
    await manager.storeMemory('agent1', {
      content: 'Never disclose payment card details on a call.',
      category: 'correction', importance: 'critical', title: 'No card details',
    });
    await manager.storeMemory('agent1', {
      content: 'The operator is based in the US Eastern timezone.',
      category: 'context', title: 'Operator timezone',
    });

    const ctx = await manager.generateMemoryContext('agent1');
    expect(ctx).toContain('## Agent Memory');
    expect(ctx).toContain('[CRITICAL]');
    expect(ctx).toContain('No card details');
    expect(ctx).toContain('Operator timezone');
  });

  it('decays confidence for stale entries but exempts critical ones', async () => {
    const { db, manager } = freshManager();
    const stale = await manager.storeMemory('agent1', { content: 'old normal note', title: 'Normal' });
    const crit = await manager.storeMemory('agent1', {
      content: 'old critical note', title: 'Critical', importance: 'critical',
    });
    // Backdate both well past the 7-day decay cutoff.
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    db.prepare('UPDATE agent_memory SET created_at = ?, last_accessed_at = NULL WHERE id IN (?, ?)')
      .run(old, stale.id, crit.id);

    const reloaded = new AgentMemoryManager(db);
    const decayed = await reloaded.decayConfidence('agent1');
    expect(decayed).toBe(1); // only the normal entry decays
    expect((await reloaded.getMemory(crit.id))!.confidence).toBe(1.0);
    expect((await reloaded.getMemory(stale.id))!.confidence).toBeLessThan(1.0);
  });

  it('prunes expired and very-low-confidence entries', async () => {
    const { db, manager } = freshManager();
    const expired = await manager.storeMemory('agent1', { content: 'expired', title: 'Expired' });
    const live = await manager.storeMemory('agent1', { content: 'live', title: 'Live' });
    db.prepare('UPDATE agent_memory SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), expired.id);

    const reloaded = new AgentMemoryManager(db);
    const pruned = await reloaded.pruneExpired('agent1');
    expect(pruned).toBe(1);
    const left = await reloaded.queryMemories({ agentId: 'agent1' });
    expect(left.map((m) => m.id)).toEqual([live.id]);
  });

  it('purges all of an agent memory on deleteAgentMemories', async () => {
    const { db, manager } = freshManager();
    await manager.storeMemory('agent1', { content: 'note one', title: 'One' });
    await manager.storeMemory('agent1', { content: 'note two', title: 'Two' });
    await manager.storeMemory('agent2', { content: 'other agent', title: 'Other' });

    const removed = await manager.deleteAgentMemories('agent1');
    expect(removed).toBe(2);
    expect(await manager.queryMemories({ agentId: 'agent1' })).toHaveLength(0);
    // Other agents untouched.
    expect(await manager.queryMemories({ agentId: 'agent2' })).toHaveLength(1);
    // DB rows gone too.
    const raw = db.prepare('SELECT COUNT(*) AS n FROM agent_memory WHERE agent_id = ?').get('agent1') as { n: number };
    expect(raw.n).toBe(0);
  });

  it('reports per-agent memory stats', async () => {
    const { manager } = freshManager();
    await manager.storeMemory('agent1', { content: 'a', title: 'A', category: 'skill', importance: 'high' });
    await manager.storeMemory('agent1', { content: 'b', title: 'B', category: 'skill', importance: 'normal' });
    await manager.storeMemory('agent1', { content: 'c', title: 'C', category: 'context', importance: 'normal' });

    const stats = await manager.getStats('agent1');
    expect(stats.totalEntries).toBe(3);
    expect(stats.byCategory.skill).toBe(2);
    expect(stats.byCategory.context).toBe(1);
    expect(stats.byImportance.high).toBe(1);
  });
});
