/**
 * Tests for the layered wake-context system:
 *   - thread-id normalization + hash stability
 *   - ThreadCache: push / read / dedup / cap / delete
 *   - AgentMemoryStore: write / read / delete + frontmatter parsing
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  threadIdFor, normalizeSubject, normalizeAddress,
  ThreadCache, AgentMemoryStore,
} from '../threading/index.js';

describe('threadIdFor — normalization', () => {
  it('strips a single Re: prefix', () => {
    expect(normalizeSubject('Re: Audit plan')).toBe('audit plan');
  });

  it('strips chained Re: / Fwd: / Re[2]: prefixes', () => {
    expect(normalizeSubject('Re: Fwd: Re[2]: Audit plan')).toBe('audit plan');
    expect(normalizeSubject('RE: FW:    Audit plan')).toBe('audit plan');
  });

  it('strips coordination markers ([FINAL] etc.) so a closing message stays in the same thread', () => {
    expect(normalizeSubject('Re: Audit plan [FINAL]')).toBe('audit plan');
    expect(normalizeSubject('[DONE] Audit plan')).toBe('audit plan');
    expect(normalizeSubject('Audit plan [CLOSED]')).toBe('audit plan');
  });

  it('collapses internal whitespace + lower-cases', () => {
    expect(normalizeSubject('  Audit\t\tPlan  ')).toBe('audit plan');
  });

  it('falls back when subject is missing or becomes empty after stripping', () => {
    expect(normalizeSubject('')).toBe('(no subject)');
    expect(normalizeSubject(undefined as unknown as string)).toBe('(no subject)');
    expect(normalizeSubject('Re: ')).toBe('(no subject)');
  });
});

describe('normalizeAddress', () => {
  it('extracts the bare email from a display-name form', () => {
    expect(normalizeAddress('Foo Bar <foo@bar.com>')).toBe('foo@bar.com');
  });
  it('lowercases', () => {
    expect(normalizeAddress('Foo@Bar.COM')).toBe('foo@bar.com');
  });
  it('falls back on empty input', () => {
    expect(normalizeAddress('')).toBe('(unknown)');
  });
});

describe('threadIdFor — hash properties', () => {
  it('produces the same id for the original message and every Re: reply', () => {
    const root = threadIdFor({ subject: 'Audit plan', rootFromAddr: 'vesper@localhost' });
    expect(threadIdFor({ subject: 'Re: Audit plan', rootFromAddr: 'vesper@localhost' })).toBe(root);
    expect(threadIdFor({ subject: 'RE: RE: Fwd: Audit plan [FINAL]', rootFromAddr: 'vesper@localhost' })).toBe(root);
  });

  it('is subject-only — replies from any sender collapse into the same thread id', () => {
    // This is the explicit contract: a reply from someone OTHER
    // than the root sender must still map to the same thread id
    // so the cache + memory lookups land on the right thread.
    // Generic-subject collisions are accepted as a tradeoff for
    // this stability. Downstream (wake-budget, thread-close) and
    // agent memory disambiguate by participants.
    const a = threadIdFor({ subject: 'audit plan', rootFromAddr: 'alice@x.com' });
    const b = threadIdFor({ subject: 'audit plan', rootFromAddr: 'bob@x.com' });
    expect(a).toBe(b);
  });

  it('is stable across runs (deterministic)', () => {
    const a = threadIdFor({ subject: 'Audit plan', rootFromAddr: 'vesper@localhost' });
    const b = threadIdFor({ subject: 'Audit plan', rootFromAddr: 'vesper@localhost' });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });
});

describe('ThreadCache', () => {
  let dir: string;
  let cache: ThreadCache;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'am-thread-cache-'));
    cache = new ThreadCache({ cacheDir: dir, k: 3, lruCap: 10 });
  });

  function pushSeq(t: string, uids: number[]) {
    for (const uid of uids) {
      cache.pushMessage(
        t,
        { uid, from: 'A <a@x>', fromAddr: 'a@x', subject: 'topic', preview: `msg${uid}`, date: `2026-05-14T00:00:${String(uid).padStart(2,'0')}Z` },
        { subject: 'topic', rootFromAddr: 'a@x' },
      );
    }
  }

  it('creates the entry on first push + persists subject/rootFromAddr', () => {
    pushSeq('t1', [1]);
    const e = cache.read('t1');
    expect(e).not.toBeNull();
    expect(e!.subject).toBe('topic');
    expect(e!.rootFromAddr).toBe('a@x');
    expect(e!.messages).toHaveLength(1);
  });

  it('caps to K newest messages', () => {
    pushSeq('t2', [1, 2, 3, 4, 5]);
    const e = cache.read('t2')!;
    expect(e.messages.map(m => m.uid)).toEqual([5, 4, 3]);
  });

  it('dedups by UID (replays of the same UID do not multiply rows)', () => {
    pushSeq('t3', [1, 1, 2, 2, 3]);
    const e = cache.read('t3')!;
    expect(e.messages.map(m => m.uid)).toEqual([3, 2, 1]);
  });

  it('preserves first-seen subject + rootFromAddr on reply pushes', () => {
    // Root message
    cache.pushMessage('t4',
      { uid: 1, from: 'A <a@x>', fromAddr: 'a@x', subject: 'plan', preview: '', date: '2026-05-14T00:00:01Z' },
      { subject: 'plan', rootFromAddr: 'a@x' });
    // Reply pushes — replier passes ITS own envelope, but the
    // cache should NOT overwrite the root.
    cache.pushMessage('t4',
      { uid: 2, from: 'B <b@x>', fromAddr: 'b@x', subject: 'Re: plan', preview: '', date: '2026-05-14T00:00:02Z' },
      { subject: 'plan', rootFromAddr: 'a@x' });
    const e = cache.read('t4')!;
    expect(e.subject).toBe('plan');
    expect(e.rootFromAddr).toBe('a@x');
    // But the per-message rows reflect each sender truthfully.
    expect(e.messages[0].fromAddr).toBe('b@x');
    expect(e.messages[1].fromAddr).toBe('a@x');
  });

  it('renderForPrompt produces a compact one-line-per-message string, empty when no entry', () => {
    expect(cache.renderForPrompt(null)).toBe('');
    pushSeq('t5', [10, 11]);
    const rendered = cache.renderForPrompt(cache.read('t5'));
    expect(rendered).toContain('UID 11');
    expect(rendered).toContain('UID 10');
    expect(rendered.split('\n')).toHaveLength(2);
  });

  it('delete() removes the file', () => {
    pushSeq('t6', [1]);
    expect(cache.read('t6')).not.toBeNull();
    cache.delete('t6');
    expect(cache.read('t6')).toBeNull();
  });

  it('corrupt cache file is evicted on read rather than crashing', () => {
    pushSeq('t7', [1]);
    // Corrupt the file in-place.
    const fs = require('node:fs');
    fs.writeFileSync(join(dir, 't7.json'), 'not json {{{');
    expect(cache.read('t7')).toBeNull();
    // And it's been removed so the next push starts fresh.
    expect(readdirSync(dir).includes('t7.json')).toBe(false);
  });
});

describe('AgentMemoryStore', () => {
  let dir: string;
  let store: AgentMemoryStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'am-agent-mem-'));
    store = new AgentMemoryStore({ memoryDir: dir });
  });

  it('write then read round-trips the fields + adds an updated_at frontmatter line', () => {
    store.write('vesper', 't1', {
      summary: 'Took Section H; awaiting Orion row 14.',
      commitments: ['Deliver section H by EOD'],
      openQuestions: ['Whether enum fan-out runs before digit-split'],
      lastAction: 'Replied UID 41 asking for raw counts',
      lastUid: 41,
    });
    const r = store.read('vesper', 't1');
    expect(r).not.toBeNull();
    expect(r!.updatedAt).toBeDefined();
    expect(r!.lastUid).toBe(41);
    expect(r!.raw).toContain('Took Section H');
    expect(r!.raw).toContain('### Commitments');
    expect(r!.raw).toContain('Deliver section H by EOD');
    expect(r!.raw).toContain('### Open');
    expect(r!.raw).toContain('### Last action');
  });

  it('returns null when no memory exists for the (agent, thread) pair', () => {
    expect(store.read('vesper', 'unknown-thread')).toBeNull();
  });

  it('one agent\'s memory is invisible to another (per-agent isolation)', () => {
    store.write('vesper', 't1', { summary: 'V notes' });
    store.write('orion',  't1', { summary: 'O notes' });
    expect(store.read('vesper', 't1')!.raw).toContain('V notes');
    expect(store.read('orion',  't1')!.raw).toContain('O notes');
    // No cross-contamination.
    expect(store.read('vesper', 't1')!.raw).not.toContain('O notes');
  });

  it('delete removes the file', () => {
    store.write('vesper', 't1', { summary: 'x' });
    store.delete('vesper', 't1');
    expect(store.read('vesper', 't1')).toBeNull();
  });

  it('sanitises agent + thread ids in the filesystem path', () => {
    // Slashes and colons are common in IMAP folder paths / message ids
    // and would break the filesystem layout if not sanitised.
    store.write('weird/agent', 'thread:with:colons', { summary: 'ok' });
    const r = store.read('weird/agent', 'thread:with:colons');
    expect(r).not.toBeNull();
  });
});

function rmrf(p: string) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
afterAllOnce(rmrf);
function afterAllOnce(_fn: (p: string) => void) { /* placeholder so noUnusedLocals is happy */ }
