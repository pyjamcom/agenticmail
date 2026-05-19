import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createTestDatabase } from '@agenticmail/core';
import { createMemoryRoutes } from '../routes/memory.js';

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

async function req(base: string, path: string, init?: RequestInit, agent = 'agent1') {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-agent': agent, ...(init?.headers || {}) },
  });
  return { status: res.status, body: await res.json() };
}

function app() {
  const db = createTestDatabase();
  const e = express();
  e.use(express.json());
  // Test auth shim: the x-agent header selects which agent is "logged in".
  e.use((r, _res, next) => { (r as any).agent = { id: String(r.headers['x-agent'] || 'agent1'), email: 'a@x.com' }; next(); });
  e.use(createMemoryRoutes(db as any));
  return e;
}

describe('memory routes', () => {
  it('stores, lists, and searches an agent memory', async () => {
    const base = await listen(app());

    const set = await req(base, '/memory', {
      method: 'POST',
      body: JSON.stringify({ content: 'Operator prefers window seats for reservations', category: 'preference', title: 'Seating' }),
    });
    expect(set.status).toBe(200);
    expect(set.body.memory.id).toBeTruthy();

    const list = await req(base, '/memory');
    expect(list.body.count).toBe(1);

    const search = await req(base, '/memory?query=reservation%20seating');
    expect(search.body.memories.length).toBeGreaterThan(0);
    expect(search.body.memories[0].title).toBe('Seating');
  });

  it('rejects an empty memory', async () => {
    const base = await listen(app());
    const set = await req(base, '/memory', { method: 'POST', body: JSON.stringify({ content: '  ' }) });
    expect(set.status).toBe(400);
  });

  it('keeps each agent memory private', async () => {
    const base = await listen(app());
    await req(base, '/memory', { method: 'POST', body: JSON.stringify({ content: 'agent1 secret', title: 'A1' }) }, 'agent1');
    await req(base, '/memory', { method: 'POST', body: JSON.stringify({ content: 'agent2 secret', title: 'A2' }) }, 'agent2');

    const a1 = await req(base, '/memory', undefined, 'agent1');
    expect(a1.body.memories.map((m: any) => m.title)).toEqual(['A1']);

    // agent2 cannot fetch agent1's entry — uniform 404.
    const a1Id = a1.body.memories[0].id;
    const probe = await req(base, `/memory/${a1Id}`, undefined, 'agent2');
    expect(probe.status).toBe(404);
  });

  it('records a reflection and surfaces it in the context digest', async () => {
    const base = await listen(app());
    await req(base, '/memory/reflect', {
      method: 'POST',
      body: JSON.stringify({ content: 'Always confirm the callback number before ending a call.', title: 'Callback rule' }),
    });
    const ctx = await req(base, '/memory/context');
    expect(ctx.body.context).toContain('## Agent Memory');
    expect(ctx.body.context).toContain('Callback rule');

    const stats = await req(base, '/memory/stats');
    expect(stats.body.stats.totalEntries).toBe(1);
    expect(stats.body.stats.byCategory.reflection).toBe(1);
  });

  it('deletes a memory entry', async () => {
    const base = await listen(app());
    const set = await req(base, '/memory', { method: 'POST', body: JSON.stringify({ content: 'forget me', title: 'Temp' }) });
    const id = set.body.memory.id;
    const del = await req(base, `/memory/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const list = await req(base, '/memory');
    expect(list.body.count).toBe(0);
  });
});
