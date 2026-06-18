import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createTestDatabase } from '@agenticmail/core';
import { createTaskRoutes } from '../routes/tasks.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('bad address');
  return `http://127.0.0.1:${a.port}`;
}

// caller header: "master" → master key; anything else → agent id.
async function req(base: string, path: string, caller: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-caller': caller, ...(init?.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const AGENTS: Record<string, { id: string; name: string; email: string }> = {
  alice: { id: 'alice', name: 'alice', email: 'alice@localhost' },
  bob: { id: 'bob', name: 'bob', email: 'bob@localhost' },
};

function buildApp() {
  const db = createTestDatabase();
  const accountManager = {
    getByName: async (name: string) => AGENTS[name.toLowerCase()] ?? null,
  } as any;
  const config = { smtp: { host: 'localhost', port: 587 } } as any;

  const e = express();
  e.use(express.json());
  // Auth shim mirroring createAuthMiddleware: "master" sets isMaster, an
  // agent name sets req.agent so requireAgent/requireAuth behave normally.
  e.use((r, _res, next) => {
    const caller = String(r.headers['x-caller'] || 'alice');
    if (caller === 'master') (r as any).isMaster = true;
    else (r as any).agent = AGENTS[caller] ?? { id: caller, name: caller, email: `${caller}@localhost` };
    next();
  });
  e.use(createTaskRoutes(db, accountManager, config));
  return { e, db };
}

/** Insert a pending task assigned to `assignee`, assigned by `assigner`. */
function seedTask(db: any, id: string, assigner: string, assignee: string) {
  db.prepare(
    "INSERT INTO agent_tasks (id, assigner_id, assignee_id, task_type, payload, status) VALUES (?, ?, ?, 'generic', ?, 'pending')",
  ).run(id, assigner, assignee, JSON.stringify({ task: 'secret task intended for bob' }));
}

describe('task routes authorization (GHSA-hjwc-26pj-v3pm)', () => {
  it("does not let an agent list another agent's pending tasks by name", async () => {
    const { e, db } = buildApp();
    seedTask(db, 'task-for-bob', 'owner', 'bob');
    const base = await listen(e);

    const cross = await req(base, '/tasks/pending?assignee=bob', 'alice');
    expect(cross.status).toBe(403);

    // Bob sees his own queue.
    const own = await req(base, '/tasks/pending', 'bob');
    expect(own.status).toBe(200);
    expect(own.body.tasks.map((t: any) => t.id)).toContain('task-for-bob');
  });

  it("does not let an unrelated agent read another agent's task by id", async () => {
    const { e, db } = buildApp();
    seedTask(db, 'task-for-bob', 'owner', 'bob');
    const base = await listen(e);

    const probe = await req(base, '/tasks/task-for-bob', 'alice');
    expect(probe.status).toBe(404);

    const asBob = await req(base, '/tasks/task-for-bob', 'bob');
    expect(asBob.status).toBe(200);
    expect(asBob.body.id).toBe('task-for-bob');
  });

  it("does not let an unrelated agent claim/complete/fail another agent's task", async () => {
    const { e, db } = buildApp();
    seedTask(db, 'task-for-bob', 'owner', 'bob');
    const base = await listen(e);

    const claim = await req(base, '/tasks/task-for-bob/claim', 'alice', { method: 'POST', body: '{}' });
    expect(claim.status).toBe(404);

    const complete = await req(base, '/tasks/task-for-bob/complete', 'alice', {
      method: 'POST', body: JSON.stringify({ result: { hijacked: true } }),
    });
    expect(complete.status).toBe(404);

    const fail = await req(base, '/tasks/task-for-bob/fail', 'alice', {
      method: 'POST', body: JSON.stringify({ error: 'nope' }),
    });
    expect(fail.status).toBe(404);

    // The task is untouched.
    const row = db.prepare('SELECT status FROM agent_tasks WHERE id = ?').get('task-for-bob') as any;
    expect(row.status).toBe('pending');
  });

  it('lets the rightful assignee claim and complete', async () => {
    const { e, db } = buildApp();
    seedTask(db, 'task-for-bob', 'owner', 'bob');
    const base = await listen(e);

    const claim = await req(base, '/tasks/task-for-bob/claim', 'bob', { method: 'POST', body: '{}' });
    expect(claim.status).toBe(200);

    const result = await req(base, '/tasks/task-for-bob/result', 'bob', {
      method: 'POST', body: JSON.stringify({ result: { done: true } }),
    });
    expect(result.status).toBe(200);
    const row = db.prepare('SELECT status FROM agent_tasks WHERE id = ?').get('task-for-bob') as any;
    expect(row.status).toBe('completed');
  });

  it('lets the assigner read the task they created', async () => {
    const { e, db } = buildApp();
    seedTask(db, 'task-for-bob', 'alice', 'bob');
    const base = await listen(e);

    const asAssigner = await req(base, '/tasks/task-for-bob', 'alice');
    expect(asAssigner.status).toBe(200);
    expect(asAssigner.body.id).toBe('task-for-bob');
  });

  it('lets the master key read any task', async () => {
    const { e, db } = buildApp();
    seedTask(db, 'task-for-bob', 'owner', 'bob');
    const base = await listen(e);

    const asMaster = await req(base, '/tasks/task-for-bob', 'master');
    expect(asMaster.status).toBe(200);
    expect(asMaster.body.id).toBe('task-for-bob');
  });
});
