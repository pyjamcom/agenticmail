/**
 * Per-agent thread memory routes.
 *
 * The dispatcher reads these files directly off disk on every
 * wake (no API round-trip needed); these endpoints exist for
 * the agent itself — via the MCP `save_thread_memory` /
 * `get_thread_id` tools — to write and inspect its own memory.
 *
 * Auth scope: agent-key (NOT master-key). An agent only ever
 * reads / writes / deletes its OWN memory. This is what keeps
 * one agent's thread judgments invisible to another sharing the
 * same thread.
 */
import { Router } from 'express';
import {
  AgentMemoryStore,
  threadIdFor,
  ThreadCache,
  type AgenticMailConfig,
} from '@agenticmail/core';
import { requireAgent } from '../middleware/auth.js';
import { getReceiver, getAgentPassword } from './mail.js';

export function createAgentMemoryRoutes(config: AgenticMailConfig): Router {
  const router = Router();
  const memoryStore = new AgentMemoryStore();
  const threadCache = new ThreadCache();

  /**
   * Read the calling agent's memory for a given thread.
   * Returns 404 when no memory exists yet — that's the cold-start
   * signal the dispatcher uses to render an empty memory block
   * rather than synthesising a placeholder.
   */
  router.get('/agents/me/memory/threads/:t', requireAgent, async (req, res, next) => {
    try {
      const t = String(req.params.t);
      const memory = memoryStore.read(req.agent!.id, t);
      if (!memory) {
        res.status(404).json({ error: 'No memory for this thread' });
        return;
      }
      res.json(memory);
    } catch (err) { next(err); }
  });

  /**
   * Write the calling agent's memory for a thread. Body fields
   * map 1:1 onto the AgentMemoryFields contract; everything is
   * optional but at least one field must be present. The file
   * is rewritten atomically — no merge with the previous version,
   * the agent is expected to pass a complete snapshot each time.
   */
  router.post('/agents/me/memory/threads/:t', requireAgent, async (req, res, next) => {
    try {
      const t = String(req.params.t);
      const { summary, commitments, openQuestions, lastAction, lastUid } = req.body ?? {};
      if (!summary && !commitments && !openQuestions && !lastAction && lastUid === undefined) {
        res.status(400).json({ error: 'At least one field is required (summary, commitments, openQuestions, lastAction, or lastUid)' });
        return;
      }
      memoryStore.write(req.agent!.id, t, {
        summary: typeof summary === 'string' ? summary : undefined,
        commitments: Array.isArray(commitments) ? commitments.map(String) : undefined,
        openQuestions: Array.isArray(openQuestions) ? openQuestions.map(String) : undefined,
        lastAction: typeof lastAction === 'string' ? lastAction : undefined,
        lastUid: typeof lastUid === 'number' ? lastUid : undefined,
      });
      res.json({ ok: true, threadId: t });
    } catch (err) { next(err); }
  });

  /**
   * Drop the calling agent's memory for a thread. Called by the
   * dispatcher (on [FINAL] markers) and exposed here so agents
   * can clear stale memory manually if they want a fresh start.
   */
  router.delete('/agents/me/memory/threads/:t', requireAgent, async (req, res, next) => {
    try {
      memoryStore.delete(req.agent!.id, String(req.params.t));
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  /**
   * Resolve a stable thread-id from a message UID. Implements
   * the `get_thread_id` MCP tool's server side.
   *
   *   GET /agents/me/thread-id?uid=42&folder=INBOX
   *
   * The flow:
   *   1. Fetch the envelope at (uid, folder).
   *   2. Look up the existing cache entry for the thread, if any.
   *      We use its `rootFromAddr` so a reply's thread id matches
   *      the root sender's, not the replier's. Cold start (no
   *      cache entry) → use the envelope's sender as the root.
   *   3. Compute and return the thread id.
   */
  router.get('/agents/me/thread-id', requireAgent, async (req, res, next) => {
    try {
      const uid = parseInt(String(req.query.uid ?? ''), 10);
      if (isNaN(uid) || uid < 1) {
        res.status(400).json({ error: 'uid query param is required' });
        return;
      }
      const folder = (req.query.folder as string) || 'INBOX';
      const password = getAgentPassword(req.agent!);
      const receiver = await getReceiver(req.agent!.stalwartPrincipal, password, config);
      const envs = await receiver.listEnvelopes(folder, { limit: 1, offset: 0 });
      const envelope = envs.find(e => e.uid === uid)
        ?? (await receiver.listEnvelopes(folder, { limit: 200, offset: 0 })).find(e => e.uid === uid);
      if (!envelope) {
        res.status(404).json({ error: `No message with UID ${uid} in folder ${folder}` });
        return;
      }
      const subject = envelope.subject ?? '';
      const senderAddr = envelope.from?.[0]?.address ?? '';
      // First-pass id guesses the envelope itself is the root.
      // We then probe the cache for an existing root sender to
      // produce the canonical id (replies need to map to the
      // root's id, not the replier's).
      const provisional = threadIdFor({ subject, rootFromAddr: senderAddr });
      const existing = threadCache.read(provisional);
      if (existing) {
        // If the provisional already matches the cache entry's
        // own rootFromAddr, we're already canonical.
        const canonical = threadIdFor({ subject, rootFromAddr: existing.rootFromAddr });
        res.json({ threadId: canonical, rootFromAddr: existing.rootFromAddr, subject: existing.subject });
        return;
      }
      // Cold start: this is treated as a new thread root.
      res.json({ threadId: provisional, rootFromAddr: senderAddr, subject });
    } catch (err) { next(err); }
  });

  return router;
}
