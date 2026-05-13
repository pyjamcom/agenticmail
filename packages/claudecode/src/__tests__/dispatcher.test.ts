/**
 * Dispatcher routing tests.
 *
 * The dispatcher's job is "translate AgenticMail events into Claude Agent
 * SDK invocations." We don't try to mock SSE wire-format here — that's a
 * fragile coverage target. Instead we drive the Dispatcher through its
 * public `handleEvent` method, which is the routing seam, and verify it
 * fires `query()` (the SDK) with the right shape.
 *
 * Dedup behaviour and assignee-filtering are explicitly tested because
 * they are the two places that quietly broken behaviour would show up as
 * "agent reacts twice to the same event" or "agent reacts to someone
 * else's task".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dispatcher, type QueryFn } from '../dispatcher.js';
import type { AgenticMailAccount } from '../types.js';

const FOLA: AgenticMailAccount = {
  id: 'fola-id',
  name: 'Fola',
  email: 'fola@localhost',
  apiKey: 'ak_fola',
  role: 'secretary',
};

const RESEARCHER: AgenticMailAccount = {
  id: 'r-id',
  name: 'researcher',
  email: 'researcher@localhost',
  apiKey: 'ak_r',
  role: 'researcher',
};

/** Mock SDK that records every call + emits a single assistant message. */
function makeMockSdk() {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const query: QueryFn = (params) => {
    calls.push({ prompt: params.prompt as string, options: (params.options ?? {}) as Record<string, unknown> });
    return (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
    })();
  };
  return { query, calls };
}

function makeDispatcher(opts: Partial<Parameters<typeof Dispatcher.prototype.handleEvent>[0]> = {}, extra?: Record<string, unknown>) {
  const sdk = makeMockSdk();
  const d = new Dispatcher({
    masterKey: 'mk_test',
    apiUrl: 'http://127.0.0.1:3200',
    agentsDir: '/tmp/agents-do-not-exist-' + Math.random(),
    querySdk: sdk.query,
    fetchImpl: vi.fn() as unknown as typeof fetch,
    log: () => {}, // silence
    ...extra,
  });
  return { d, sdk };
}

beforeEach(() => {
  // Keep tests deterministic regardless of any leaked env.
  delete process.env.AGENTICMAIL_API_URL;
});

describe('Dispatcher.handleEvent — new-mail routing', () => {
  it('spawns a worker on new mail and passes a wake prompt mentioning the sender/subject', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, {
      type: 'new',
      uid: 42,
      from: 'boss@external.com',
      subject: 'Q3 numbers please',
    });
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0].prompt).toContain('boss@external.com');
    expect(sdk.calls[0].prompt).toContain('Q3 numbers please');
    expect(sdk.calls[0].prompt).toContain('UID: 42');
  });

  it('dedups: the same UID arriving twice triggers only one worker', async () => {
    const { d, sdk } = makeDispatcher();
    // Pre-populate the channel state so handleEvent knows the agent.
    (d as unknown as { channels: Map<string, unknown> }).channels.set(FOLA.id, {
      account: FOLA, controller: null, stopping: false, backoffMs: 0,
      seenUids: new Set(), seenTaskIds: new Set(), suppressTaskMailUntilMs: 0,
    });
    await d.handleEvent(FOLA, { type: 'new', uid: 99, from: 'x', subject: 'y' });
    await d.handleEvent(FOLA, { type: 'new', uid: 99, from: 'x', subject: 'y' });
    expect(sdk.calls).toHaveLength(1);
  });

  it('passes the right MCP server config in worker options', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, { type: 'new', uid: 1 });
    const opts = sdk.calls[0].options;
    expect(opts.systemPrompt).toMatch(/You are \*\*Fola\*\*/);
    const mcpServers = opts.mcpServers as Record<string, { env: Record<string, string> }>;
    expect(mcpServers.agenticmail.env.AGENTICMAIL_MASTER_KEY).toBe('mk_test');
    // Workers should NOT get a default API key — every call must pass _account.
    expect(mcpServers.agenticmail.env.AGENTICMAIL_API_KEY).toBeUndefined();
  });

  it('restricts allowedTools to the MCP toolbelt only (no Bash / Read / Edit)', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, { type: 'new', uid: 1 });
    const allowed = sdk.calls[0].options.allowedTools as string[];
    for (const t of allowed) {
      expect(t.startsWith('mcp__agenticmail__')).toBe(true);
    }
    // Coordination primitive must be present.
    expect(allowed).toContain('mcp__agenticmail__call_agent');
  });
});

describe('Dispatcher.handleEvent — task routing', () => {
  it('spawns a worker on task assignment with a claim+submit prompt', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, {
      type: 'task',
      taskId: 't-1',
      taskType: 'rpc',
      task: 'Summarise unread mail',
      assignee: 'Fola',
      from: 'claudecode',
    });
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0].prompt).toContain('claim_task');
    expect(sdk.calls[0].prompt).toContain('submit_result');
    expect(sdk.calls[0].prompt).toContain('t-1');
    expect(sdk.calls[0].prompt).toContain('Summarise unread mail');
  });

  it('ignores task events where assignee is a different agent (broadcast-route protection)', async () => {
    const { d, sdk } = makeDispatcher();
    // Fola's channel hears a broadcast for researcher — must NOT wake Fola.
    await d.handleEvent(FOLA, {
      type: 'task',
      taskId: 't-2',
      task: 'irrelevant',
      assignee: 'researcher',
    });
    expect(sdk.calls).toHaveLength(0);
  });

  it('dedups task events with the same taskId', async () => {
    const { d, sdk } = makeDispatcher();
    (d as unknown as { channels: Map<string, unknown> }).channels.set(FOLA.id, {
      account: FOLA, controller: null, stopping: false, backoffMs: 0,
      seenUids: new Set(), seenTaskIds: new Set(), suppressTaskMailUntilMs: 0,
    });
    await d.handleEvent(FOLA, { type: 'task', taskId: 't-3', task: 'x', assignee: 'Fola' });
    await d.handleEvent(FOLA, { type: 'task', taskId: 't-3', task: 'x', assignee: 'Fola' });
    expect(sdk.calls).toHaveLength(1);
  });

  it('case-insensitive assignee match (assignee="fola" should match account "Fola")', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, {
      type: 'task',
      taskId: 't-4',
      task: 'lowercase assignee',
      assignee: 'fola',
    });
    expect(sdk.calls).toHaveLength(1);
  });
});

describe('Dispatcher cross-type dedup (task event + RPC notification mail)', () => {
  function preChannel(d: Dispatcher) {
    (d as unknown as { channels: Map<string, unknown> }).channels.set(FOLA.id, {
      account: FOLA, controller: null, stopping: false, backoffMs: 0,
      seenUids: new Set(), seenTaskIds: new Set(), suppressTaskMailUntilMs: 0,
    });
  }

  it('suppresses an [RPC] notification mail that arrives right after a task event', async () => {
    const { d, sdk } = makeDispatcher();
    preChannel(d);
    await d.handleEvent(FOLA, { type: 'task', taskId: 't-x', task: 'do thing', assignee: 'Fola', from: 'claudecode' });
    // Simulate the master API's notification mail landing 30ms later.
    await d.handleEvent(FOLA, { type: 'new', uid: 200, from: 'claudecode@localhost', subject: '[RPC] Task from claudecode: do thing' });
    // One worker, not two.
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0].prompt).toContain('claim_task');
  });

  it('suppresses when subject lives at event.message.subject (the real SSE wire shape)', async () => {
    // Regression test for a real production bug — the master API emits
    // new-mail events with `subject` nested under `message` (the full
    // IMAP envelope), not at the top level. Reading event.subject
    // directly was returning undefined and silently bypassing dedup.
    const { d, sdk } = makeDispatcher();
    preChannel(d);
    await d.handleEvent(FOLA, { type: 'task', taskId: 't-nested', task: 'do', assignee: 'Fola' });
    await d.handleEvent(FOLA, {
      type: 'new',
      uid: 999,
      message: {
        subject: '[RPC] Task from claudecode: do',
        from: [{ address: 'claudecode@localhost' }],
      },
    });
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0].prompt).toContain('claim_task');
  });

  it('falls back to event.message.subject when constructing the wake prompt for non-task mail', async () => {
    // Same path independence for the "you have new mail" prompt — must
    // pull subject from either location for the agent to see useful info.
    const { d, sdk } = makeDispatcher();
    preChannel(d);
    await d.handleEvent(FOLA, {
      type: 'new',
      uid: 1001,
      message: { subject: 'Q3 numbers please', from: [{ address: 'boss@example.com' }] },
    });
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0].prompt).toContain('Q3 numbers please');
    expect(sdk.calls[0].prompt).toContain('boss@example.com');
  });

  it('suppresses [Task]-prefixed notifications too (used by /tasks/assign)', async () => {
    const { d, sdk } = makeDispatcher();
    preChannel(d);
    await d.handleEvent(FOLA, { type: 'task', taskId: 't-y', task: 'something', assignee: 'Fola' });
    await d.handleEvent(FOLA, { type: 'new', uid: 201, from: 'x', subject: '[Task] generic from claudecode' });
    expect(sdk.calls).toHaveLength(1);
  });

  it('does NOT suppress an unrelated mail just because a task is recent', async () => {
    const { d, sdk } = makeDispatcher();
    preChannel(d);
    await d.handleEvent(FOLA, { type: 'task', taskId: 't-z', task: 'do thing', assignee: 'Fola' });
    // A real user email lands during the suppression window — must still wake.
    await d.handleEvent(FOLA, { type: 'new', uid: 202, from: 'boss@example.com', subject: 'Q3 numbers please' });
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1].prompt).toContain('Q3 numbers please');
  });

  it('does NOT suppress a notification mail that arrives AFTER the suppression window has elapsed', async () => {
    // Simulate the SSE reconnect-recovery case: dispatcher missed the task event
    // entirely, then sees only the notification mail. That mail MUST wake the
    // worker — it's our only signal.
    const { d, sdk } = makeDispatcher();
    preChannel(d);
    // No prior task event; suppressTaskMailUntilMs stays at 0.
    await d.handleEvent(FOLA, { type: 'new', uid: 203, from: 'x', subject: '[RPC] Task from claudecode: recovered task' });
    expect(sdk.calls).toHaveLength(1);
    // The wake is via the new-mail path (not the task path) — prompt confirms.
    expect(sdk.calls[0].prompt).toContain('new mail');
  });

  it('still dedups by uid — same suppressed uid does not later re-fire', async () => {
    const { d, sdk } = makeDispatcher();
    preChannel(d);
    await d.handleEvent(FOLA, { type: 'task', taskId: 't-w', task: 'x', assignee: 'Fola' });
    await d.handleEvent(FOLA, { type: 'new', uid: 204, from: 'x', subject: '[RPC] Task from y: x' });
    // Even if the same uid event somehow arrives again, we don't wake on it.
    await d.handleEvent(FOLA, { type: 'new', uid: 204, from: 'x', subject: '[RPC] Task from y: x' });
    expect(sdk.calls).toHaveLength(1);
  });
});

describe('Dispatcher.handleEvent — ignores noise', () => {
  it('does nothing on connected / reconnecting / expunge events', async () => {
    const { d, sdk } = makeDispatcher();
    for (const ev of [
      { type: 'connected', agentId: FOLA.id },
      { type: 'reconnecting', attempt: 1, delayMs: 1000 },
      { type: 'expunge', uid: 5 },
      { type: 'flags', uid: 5 },
      { type: 'error', message: 'foo' },
    ]) {
      await d.handleEvent(FOLA, ev);
    }
    expect(sdk.calls).toHaveLength(0);
  });

  it('ignores events with missing required fields (no uid for new, no taskId for task)', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, { type: 'new', from: 'x' }); // no uid
    await d.handleEvent(FOLA, { type: 'task', task: 'x' }); // no taskId
    expect(sdk.calls).toHaveLength(0);
  });
});

describe('Dispatcher concurrency', () => {
  it('caps simultaneous workers at maxConcurrentWorkers', async () => {
    // Build a slow SDK so the dispatcher's semaphore is observable.
    let running = 0;
    let maxObserved = 0;
    const slowQuery: QueryFn = () => {
      running++;
      maxObserved = Math.max(maxObserved, running);
      return (async function* () {
        await new Promise(r => setTimeout(r, 50));
        running--;
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
      })();
    };
    const d = new Dispatcher({
      masterKey: 'mk_test',
      apiUrl: 'http://127.0.0.1:3200',
      agentsDir: '/tmp/no-agents-' + Math.random(),
      querySdk: slowQuery,
      maxConcurrentWorkers: 3,
      log: () => {},
    });
    const events = Array.from({ length: 10 }, (_, i) =>
      d.handleEvent(FOLA, { type: 'new', uid: 1000 + i, from: 'x', subject: 'y' })
    );
    await Promise.all(events);
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThanOrEqual(1);
  });
});

describe('Dispatcher construction', () => {
  it('refuses to construct without a master key', () => {
    expect(() => new Dispatcher({ masterKey: '', agenticmailConfigPath: '/nonexistent-do-not-find' }))
      .toThrow(/master key/);
  });
});
