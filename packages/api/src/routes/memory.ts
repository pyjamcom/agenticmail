import { Router, type Request, type Response } from 'express';
import { AgentMemoryManager } from '@agenticmail/core';

/**
 * Persistent per-agent memory routes. Every endpoint is scoped to the
 * authenticated agent (`req.agent`) — an agent can only ever read or
 * write its own memory. One shared AgentMemoryManager backs the routes
 * so the in-memory cache + search index stay coherent.
 */

function getAgent(req: Request, res: Response): { id: string; email: string } | null {
  const agent = (req as any).agent;
  if (!agent) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return agent;
}

function fail(res: Response, err: unknown): void {
  const msg = (err as Error)?.message ?? String(err);
  const status = msg.includes('not found') ? 404
    : (msg.includes('required') || msg.includes('Invalid') || msg.includes('must be')) ? 400
    : 500;
  res.status(status).json({ error: msg });
}

export function createMemoryRoutes(
  db: ReturnType<typeof import('@agenticmail/core').getDatabase>,
): Router {
  const router = Router();
  const memory = new AgentMemoryManager(db as any);

  // POST /memory — store a memory entry for this agent
  router.post('/memory', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
      if (!content) return res.status(400).json({ error: 'content is required' });

      const entry = await memory.storeMemory(agent.id, {
        content,
        category: typeof req.body?.category === 'string' ? req.body.category : undefined,
        importance: typeof req.body?.importance === 'string' ? req.body.importance : undefined,
        confidence: typeof req.body?.confidence === 'number' ? req.body.confidence : undefined,
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        tags: Array.isArray(req.body?.tags) ? req.body.tags.filter((t: unknown) => typeof t === 'string') : undefined,
      });
      res.json({ success: true, memory: entry });
    } catch (err) { fail(res, err); }
  });

  // GET /memory — list / search this agent's memory
  router.get('/memory', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
      const entries = await memory.queryMemories({
        agentId: agent.id,
        category: typeof req.query.category === 'string' ? req.query.category : undefined,
        importance: typeof req.query.importance === 'string' ? req.query.importance : undefined,
        source: typeof req.query.source === 'string' ? req.query.source : undefined,
        query: typeof req.query.query === 'string' ? req.query.query : undefined,
        limit,
      });
      res.json({ memories: entries, count: entries.length });
    } catch (err) { fail(res, err); }
  });

  // GET /memory/context — ranked markdown memory block for prompt injection
  router.get('/memory/context', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const maxTokens = Math.min(Math.max(parseInt(String(req.query.maxTokens ?? '1500'), 10) || 1500, 100), 8000);
      const context = await memory.generateMemoryContext(
        agent.id,
        typeof req.query.query === 'string' ? req.query.query : undefined,
        maxTokens,
      );
      res.json({ context });
    } catch (err) { fail(res, err); }
  });

  // GET /memory/stats — aggregate stats for this agent's memory
  router.get('/memory/stats', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      res.json({ stats: await memory.getStats(agent.id) });
    } catch (err) { fail(res, err); }
  });

  // POST /memory/reflect — record a self-reflection (high-confidence reflection entry)
  router.post('/memory/reflect', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
      if (!content) return res.status(400).json({ error: 'content is required' });

      const entry = await memory.createMemory({
        agentId: agent.id,
        category: 'reflection',
        title: typeof req.body?.title === 'string' && req.body.title.trim()
          ? req.body.title.trim() : content.slice(0, 80),
        content,
        source: 'self_reflection',
        importance: typeof req.body?.importance === 'string' ? req.body.importance as any : 'normal',
        confidence: 0.9,
        tags: ['reflection'],
        metadata: {},
      });
      res.json({ success: true, memory: entry });
    } catch (err) { fail(res, err); }
  });

  // GET /memory/:id — fetch one entry (records an access)
  router.get('/memory/:id', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const entry = await memory.getMemory(req.params.id);
      if (!entry || entry.agentId !== agent.id) {
        return res.status(404).json({ error: 'Memory entry not found' });
      }
      await memory.recordAccess(entry.id);
      res.json({ memory: entry });
    } catch (err) { fail(res, err); }
  });

  // DELETE /memory/:id — delete one entry
  router.delete('/memory/:id', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const entry = await memory.getMemory(req.params.id);
      // 404 uniformly whether it is missing or owned by another agent —
      // an agent must not be able to probe another agent's memory ids.
      if (!entry || entry.agentId !== agent.id) {
        return res.status(404).json({ error: 'Memory entry not found' });
      }
      await memory.deleteMemory(entry.id);
      res.json({ success: true, deleted: entry.id });
    } catch (err) { fail(res, err); }
  });

  return router;
}
