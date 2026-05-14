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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  // Each Dispatcher instance gets its own tmpdir for cache + memory
  // so tests can't bleed into the real ~/.agenticmail/ paths and
  // can't bleed into each other.
  const threadCacheDir = mkdtempSync(join(tmpdir(), 'am-disp-cache-'));
  const agentMemoryDir = mkdtempSync(join(tmpdir(), 'am-disp-mem-'));
  const d = new Dispatcher({
    masterKey: 'mk_test',
    apiUrl: 'http://127.0.0.1:3200',
    agentsDir: '/tmp/agents-do-not-exist-' + Math.random(),
    querySdk: sdk.query,
    fetchImpl: vi.fn() as unknown as typeof fetch,
    log: () => {}, // silence
    threadCacheDir,
    agentMemoryDir,
    // Default-off coalescing for the existing test suite — every
    // pre-0.9.0 test asserts "one event = one spawn". Tests that
    // need to exercise coalescing pass `wakeCoalesceMs: 30000`
    // (or use fake timers) explicitly.
    wakeCoalesceMs: 0,
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

  it('compact-and-continue: retries with a checkpoint after a context-overflow error', async () => {
    // Mock SDK that throws "prompt is too long" on the first call,
    // succeeds on the second. The dispatcher should observe the
    // failure, build a continuation prompt, and call SDK again.
    const calls: Array<{ prompt: string }> = [];
    let attempt = 0;
    const query: QueryFn = (params) => {
      const promptStr = params.prompt as string;
      calls.push({ prompt: promptStr });
      attempt++;
      if (attempt === 1) {
        return (async function* () {
          // Emit one fake tool_use so the breadcrumb capture has
          // something to fold into the continuation prompt.
          yield {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'Read', input: { path: '/x' } }] },
          };
          throw new Error('prompt is too long: 200000 tokens > 200000 max');
        })();
      }
      return (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
      })();
    };
    const d = new Dispatcher({
      masterKey: 'mk_test',
      apiUrl: 'http://127.0.0.1:3200',
      agentsDir: '/tmp/agents-do-not-exist-' + Math.random(),
      querySdk: query,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      log: () => {},
      wakeCoalesceMs: 0,  // synchronous spawn for the assertion below
    });
    await d.handleEvent(FOLA, { type: 'new', uid: 7, from: 'a', subject: 'big task' });
    expect(calls).toHaveLength(2);
    // Second call's prompt must contain the resume marker so we know
    // it's a continuation, not a duplicate first-turn spawn.
    expect(calls[1].prompt).toContain('Resuming after context reset');
    expect(calls[1].prompt).toContain('do NOT redo');
    // First call's prompt must NOT contain the marker (sanity).
    expect(calls[0].prompt).not.toContain('Resuming after context reset');
  });

  it('does NOT pass allowedTools — workers inherit the full native + MCP toolset', async () => {
    // Earlier versions of the dispatcher locked workers to MCP-only
    // tools. That turned "implement this game" into "paste source code
    // into an email body" because workers had no Read/Write/Bash/etc.
    // Omitting allowedTools lets the SDK grant the full toolset.
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, { type: 'new', uid: 1 });
    expect(sdk.calls[0].options.allowedTools).toBeUndefined();
  });
});

describe('Dispatcher.handleEvent — wake-budget circuit breaker', () => {
  it('caps wakes per (agent, thread) so reply loops cannot run forever', async () => {
    // Same subject, different UIDs → all hit the same threadId. Cap at 3
    // for a clean assertion; default is 10 in production.
    const { d, sdk } = makeDispatcher({}, { maxWakesPerThread: 3 });
    for (let uid = 1; uid <= 10; uid++) {
      await d.handleEvent(FOLA, {
        type: 'new', uid,
        from: 'orion@localhost',
        subject: uid === 1 ? 'Build a game' : 'Re: Build a game',
      });
    }
    // Exactly 3 spawns — the 4th through 10th are budget-rejected.
    expect(sdk.calls).toHaveLength(3);
  });

  it('leading-edge coalesce: first event fires immediately, subsequent events coalesce into a second wake', async () => {
    vi.useFakeTimers();
    try {
      // 200 ms debounce window so we can advance through it without
      // waiting in wall-clock time.
      const { d, sdk } = makeDispatcher({}, { wakeCoalesceMs: 200 });
      // First event for a new (agent, thread) — should spawn
      // immediately, no debounce wait.
      await d.handleEvent(FOLA, { type: 'new', uid: 50, from: 'orion', subject: 'Audit plan' });
      expect(sdk.calls).toHaveLength(1);
      // Two more events arrive INSIDE the window — they go onto
      // the queue but do not spawn until the timer fires.
      vi.advanceTimersByTime(20);
      await d.handleEvent(FOLA, { type: 'new', uid: 51, from: 'orion', subject: 'Re: Audit plan' });
      vi.advanceTimersByTime(20);
      await d.handleEvent(FOLA, { type: 'new', uid: 52, from: 'orion', subject: 'Re: Audit plan' });
      // Still just the leading-edge spawn.
      expect(sdk.calls).toHaveLength(1);
      // Crossing the window fires the coalesced trailing wake
      // covering UIDs 51 and 52 (the leading-edge UID 50 already
      // ran in the first spawn).
      await vi.advanceTimersByTimeAsync(250);
      expect(sdk.calls).toHaveLength(2);
      expect(sdk.calls[1].prompt).toContain('UID 51');
      expect(sdk.calls[1].prompt).toContain('UID 52');
      expect(sdk.calls[1].prompt).toContain('coalesced');
      // The leading-edge wake did NOT see the later UIDs.
      expect(sdk.calls[0].prompt).not.toContain('UID 51');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lone leading-edge wake: timer fires with empty queue → no second spawn, no crash', async () => {
    // Regression for 0.9.6: a fresh thread with exactly ONE event used
    // to crash the dispatcher when the debounce timer expired with the
    // sentinel queue entry still in place but `events: []`. fireCoalescedWake
    // would fall through to newMailPromptForBatch(account, []) and throw
    // TypeError: Cannot read properties of undefined (reading 'uid').
    vi.useFakeTimers();
    try {
      const { d, sdk } = makeDispatcher({}, { wakeCoalesceMs: 200 });
      await d.handleEvent(FOLA, { type: 'new', uid: 77, from: 'orion', subject: 'Lone reply' });
      expect(sdk.calls).toHaveLength(1);  // leading-edge fired
      // Cross the debounce window with NO follow-up events. The timer
      // must clean up the sentinel without spawning a second worker
      // and without throwing.
      await vi.advanceTimersByTimeAsync(250);
      expect(sdk.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops queued wakes for UIDs the worker already read during its turn', async () => {
    vi.useFakeTimers();
    try {
      // 200 ms debounce — long enough that we can land a "new mail"
      // event in the queue while the first worker is still running.
      const { d, sdk } = makeDispatcher({}, { wakeCoalesceMs: 200 });
      // Replace the mock SDK with one that emits a tool_use frame
      // for read_email(uid=200) — simulating the worker
      // proactively reading mail that arrived mid-turn.
      const calls: Array<{ prompt: string }> = [];
      let attempt = 0;
      (d as unknown as { query: QueryFn }).query = ((params: Parameters<QueryFn>[0]) => {
        calls.push({ prompt: params.prompt as string });
        attempt++;
        return (async function* () {
          if (attempt === 1) {
            yield {
              type: 'assistant',
              message: { content: [{ type: 'tool_use', name: 'mcp__agenticmail__read_email', input: { uid: 200, _account: 'Fola' } }] },
            };
          }
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
        })();
      }) as QueryFn;
      // Pre-populate the channel so handleEvent sees an existing channel.
      (d as unknown as { channels: Map<string, unknown> }).channels.set(FOLA.id, {
        account: FOLA, controller: null, stopping: false, backoffMs: 0,
        seenUids: new Set(), seenTaskIds: new Set(), suppressTaskMailUntilMs: 0,
      });
      // First event lands → leading-edge fires immediately.
      await d.handleEvent(FOLA, { type: 'new', uid: 100, from: 'orion', subject: 'Audit plan' });
      // Second event for UID 200 lands mid-turn → goes into the
      // coalesce queue (subsequent burst event on same thread).
      vi.advanceTimersByTime(20);
      await d.handleEvent(FOLA, { type: 'new', uid: 200, from: 'orion', subject: 'Re: Audit plan' });
      // Worker finished (the first call's async iterator drained
      // synchronously here). Dedup logic should have dropped 200
      // from the queue because the worker `read_email`'d it.
      await vi.advanceTimersByTimeAsync(250);
      // Exactly ONE call — leading-edge fired for 100; trailing
      // wake for 200 dropped via digest dedup.
      expect(calls).toHaveLength(1);
      expect(calls[0].prompt).toContain('UID: 100');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces 30s default has zero perceived latency for a lone reply (leading-edge fires immediately)', async () => {
    // Regression test for 0.9.1: the user's complaint that "dispatcher
    // is silent for 30 s after a wake" was the trailing-edge-only
    // implementation. The lone-reply case must spawn synchronously.
    const { d, sdk } = makeDispatcher({}, { wakeCoalesceMs: 30_000 });
    await d.handleEvent(FOLA, { type: 'new', uid: 99, from: 'orion', subject: 'Lone reply' });
    expect(sdk.calls).toHaveLength(1);  // already fired, no waiting
  });

  it('injects a "Thread context" block on the second wake of the same thread', async () => {
    // First wake on a new thread → cache is empty, no context
    // block prepended (clean prompt). Second wake → cache now
    // has the first event in it, the wake prompt MUST include
    // a "Thread context" section with the first message visible
    // and the canonical end-of-turn save_thread_memory reminder.
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, { type: 'new', uid: 10, from: 'orion', subject: 'Audit plan' });
    await d.handleEvent(FOLA, { type: 'new', uid: 11, from: 'orion', subject: 'Re: Audit plan' });
    expect(sdk.calls).toHaveLength(2);
    // First call has no thread-context block (cold thread).
    expect(sdk.calls[0].prompt).not.toContain('## Thread context');
    // Second call shows facts about the prior UID + the save-memory reminder.
    expect(sdk.calls[1].prompt).toContain('## Thread context');
    expect(sdk.calls[1].prompt).toContain('### Facts');
    expect(sdk.calls[1].prompt).toContain('UID 10');
    expect(sdk.calls[1].prompt).toContain('save_thread_memory');
  });

  it('treats Re: prefixes as the same thread (subject normalisation)', async () => {
    const { d, sdk } = makeDispatcher({}, { maxWakesPerThread: 2 });
    await d.handleEvent(FOLA, { type: 'new', uid: 1, from: 'a', subject: 'Project Acme' });
    await d.handleEvent(FOLA, { type: 'new', uid: 2, from: 'a', subject: 'Re: Project Acme' });
    await d.handleEvent(FOLA, { type: 'new', uid: 3, from: 'a', subject: 'Re[2]: Project Acme' });
    // Cap is 2 so the third (still the same thread) drops.
    expect(sdk.calls).toHaveLength(2);
  });

  it('different threads have independent budgets', async () => {
    const { d, sdk } = makeDispatcher({}, { maxWakesPerThread: 2 });
    await d.handleEvent(FOLA, { type: 'new', uid: 1, from: 'a', subject: 'Topic A' });
    await d.handleEvent(FOLA, { type: 'new', uid: 2, from: 'a', subject: 'Re: Topic A' });
    await d.handleEvent(FOLA, { type: 'new', uid: 3, from: 'a', subject: 'Re: Topic A' }); // dropped
    await d.handleEvent(FOLA, { type: 'new', uid: 4, from: 'a', subject: 'Topic B' });   // different thread, allowed
    await d.handleEvent(FOLA, { type: 'new', uid: 5, from: 'a', subject: 'Re: Topic B' }); // allowed
    expect(sdk.calls).toHaveLength(4);
  });

  it('resets the budget after the wake window expires', async () => {
    let fakeNow = 1_000_000;
    const { d, sdk } = makeDispatcher({}, {
      maxWakesPerThread: 2,
      wakeWindowMs: 60_000,
      nowMs: () => fakeNow,
    });
    await d.handleEvent(FOLA, { type: 'new', uid: 1, from: 'a', subject: 'Topic' });
    await d.handleEvent(FOLA, { type: 'new', uid: 2, from: 'a', subject: 'Re: Topic' });
    await d.handleEvent(FOLA, { type: 'new', uid: 3, from: 'a', subject: 'Re: Topic' }); // capped
    expect(sdk.calls).toHaveLength(2);
    // Fast-forward beyond the window — counter resets.
    fakeNow += 60_001;
    await d.handleEvent(FOLA, { type: 'new', uid: 4, from: 'a', subject: 'Re: Topic' });
    expect(sdk.calls).toHaveLength(3);
  });

  it('skipping subject (empty thread context) bypasses the budget', async () => {
    // No subject = no thread = no loop risk. We never want to penalise
    // legitimate standalone emails just because a noisy thread elsewhere
    // tripped its own circuit breaker.
    const { d, sdk } = makeDispatcher({}, { maxWakesPerThread: 1 });
    for (let uid = 1; uid <= 5; uid++) {
      await d.handleEvent(FOLA, { type: 'new', uid, from: 'x', subject: '' });
    }
    expect(sdk.calls).toHaveLength(5);
  });
});

describe('Dispatcher.handleEvent — selective wake allowlist', () => {
  it('absent allowlist → wake everyone (backwards compatible)', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, { type: 'new', uid: 1, from: 'x', subject: 'hi' });
    expect(sdk.calls).toHaveLength(1);
  });

  it('present allowlist with the agent → wake them', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, {
      type: 'new', uid: 1, from: 'x', subject: 'hi',
      wakeAllowlist: ['fola', 'orion'],
    });
    expect(sdk.calls).toHaveLength(1);
  });

  it('present allowlist WITHOUT the agent → skip the worker entirely', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, {
      type: 'new', uid: 1, from: 'x', subject: 'hi',
      wakeAllowlist: ['orion', 'researcher'], // Fola not listed
    });
    expect(sdk.calls).toHaveLength(0);
  });

  it('empty allowlist (`wake: []`) → wake nobody, deliver silently', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, {
      type: 'new', uid: 1, from: 'x', subject: 'hi',
      wakeAllowlist: [],
    });
    expect(sdk.calls).toHaveLength(0);
  });

  it('allowlist matching is case-insensitive', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, {
      type: 'new', uid: 1, from: 'x', subject: 'hi',
      wakeAllowlist: ['FOLA'], // upper-case
    });
    expect(sdk.calls).toHaveLength(1);
  });

  it('wake allowlist check runs BEFORE budget — does not consume a wake slot', async () => {
    // The allowlist skip must NOT decrement the wake-budget counter.
    // Otherwise a noisy thread with selective wakes could prematurely
    // trip the circuit breaker for the agent that IS supposed to act.
    const { d, sdk } = makeDispatcher({}, { maxWakesPerThread: 2 });
    // 5 events on the same thread, all excluding Fola from the wake list.
    for (let uid = 1; uid <= 5; uid++) {
      await d.handleEvent(FOLA, {
        type: 'new', uid,
        from: 'x',
        subject: uid === 1 ? 'Project' : 'Re: Project',
        wakeAllowlist: ['orion'], // Fola never woken
      });
    }
    expect(sdk.calls).toHaveLength(0);
    // Now one event WITH Fola on the list — budget should be untouched.
    await d.handleEvent(FOLA, {
      type: 'new', uid: 6, from: 'x', subject: 'Re: Project',
      wakeAllowlist: ['fola'],
    });
    expect(sdk.calls).toHaveLength(1);
  });

  it('wake-prompt tells agents to use `wake` on their own replies', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, { type: 'new', uid: 1, from: 'x', subject: 'hi' });
    const prompt = sdk.calls[0].prompt as string;
    expect(prompt).toMatch(/wake:/);
    // The reply-addressing section (rewritten in 0.9.2) teaches the
    // explicit-wake pattern. We assert the wake-target idiom appears
    // somewhere — the exact prose has been reworked several times but
    // the example `wake: ["next-actor"]` form is the load-bearing bit.
    expect(prompt).toMatch(/wake:\s*\[/);
  });
});

describe('Dispatcher.handleEvent — thread-closed markers', () => {
  it('skips waking workers when subject contains [FINAL]', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, {
      type: 'new', uid: 1,
      from: 'boss@external.com',
      subject: '[FINAL] Project complete — thanks team',
    });
    expect(sdk.calls).toHaveLength(0);
  });

  it('also honours [DONE], [CLOSED], and [WRAP] markers', async () => {
    const { d: d1, sdk: s1 } = makeDispatcher();
    await d1.handleEvent(FOLA, { type: 'new', uid: 1, from: 'x', subject: '[DONE] wrap' });
    expect(s1.calls).toHaveLength(0);

    const { d: d2, sdk: s2 } = makeDispatcher();
    await d2.handleEvent(FOLA, { type: 'new', uid: 1, from: 'x', subject: '[CLOSED] wrap' });
    expect(s2.calls).toHaveLength(0);

    const { d: d3, sdk: s3 } = makeDispatcher();
    await d3.handleEvent(FOLA, { type: 'new', uid: 1, from: 'x', subject: '[WRAP] wrap' });
    expect(s3.calls).toHaveLength(0);
  });

  it('matches the marker anywhere in the subject (case-insensitive)', async () => {
    // Mail clients add Re: in front of the original subject, so the marker
    // can end up mid-string rather than at the start. Honour it anyway.
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, {
      type: 'new', uid: 1, from: 'x',
      subject: 'Re: [final] My Project — wrap-up',
    });
    expect(sdk.calls).toHaveLength(0);
  });

  it('still wakes for normal subjects that just mention the markers in passing', async () => {
    // Defensive check — `[FINAL]` etc. only triggers when the bracketed
    // form is intentionally placed. A subject like "final report due"
    // without brackets should NOT silence the thread.
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, {
      type: 'new', uid: 1, from: 'x',
      subject: 'Re: Final report due Friday',
    });
    expect(sdk.calls).toHaveLength(1);
  });

  it('the wake prompt instructs agents on how to close threads', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, { type: 'new', uid: 1, from: 'x', subject: 'Hi' });
    expect(sdk.calls).toHaveLength(1);
    const prompt = sdk.calls[0].prompt as string;
    expect(prompt).toMatch(/\[FINAL\]/);
    expect(prompt).toMatch(/\[DONE\]/);
    expect(prompt).toMatch(/wrap/i);
  });

  it('the wake prompt explicitly tells agents to check their prior contributions', async () => {
    const { d, sdk } = makeDispatcher();
    await d.handleEvent(FOLA, { type: 'new', uid: 1, from: 'x', subject: 'Hi' });
    const prompt = sdk.calls[0].prompt as string;
    // The dedup guidance — most common multi-agent failure mode.
    expect(prompt).toMatch(/prior contributions/i);
    expect(prompt).toMatch(/do NOT redo/);
    // The agent's own email should be named so they know what `from`
    // value to filter their search results on.
    expect(prompt).toContain(FOLA.email);
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
      // legacy 'error' frame from imapflow carried a string `message`
      // field; the dispatcher just drops non-new/non-task types, so
      // the field shape doesn't matter. Cast through unknown to bypass
      // SSEEvent's stricter typing (message is {subject,from,to}).
      { type: 'error', message: 'foo' } as unknown,
    ]) {
      await d.handleEvent(FOLA, ev as Parameters<typeof d.handleEvent>[1]);
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
      wakeCoalesceMs: 0,  // synchronous spawn so the semaphore is observable
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
