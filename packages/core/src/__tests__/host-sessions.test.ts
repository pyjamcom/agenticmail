import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The module reads HOME via os.homedir() at import time to compute
// STORAGE_PATH. We hijack os.homedir() to point at a tempdir so each
// test gets a clean slate without touching the real ~/.agenticmail.
let testHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => testHome,
  };
});

import {
  saveHostSession,
  loadHostSession,
  isSessionFresh,
  forgetHostSession,
  hostSessionStoragePath,
  DEFAULT_SESSION_MAX_AGE_MS,
  type HostName,
} from '../host-sessions.js';

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'amhs-'));
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
});

describe('saveHostSession / loadHostSession', () => {
  const knownHosts: HostName[] = ['claudecode', 'codex', 'openclaw', 'gemini', 'hermes'];

  it('round-trips a session', () => {
    saveHostSession('claudecode', {
      sessionId: 'abc-123',
      workspace: '/Users/ope/projects/foo',
      model: 'claude-sonnet-4-5',
    });
    const got = loadHostSession('claudecode');
    expect(got).not.toBeNull();
    expect(got!.sessionId).toBe('abc-123');
    expect(got!.workspace).toBe('/Users/ope/projects/foo');
    expect(got!.model).toBe('claude-sonnet-4-5');
    expect(got!.lastSeenMs).toBeGreaterThan(0);
  });

  it('supports all known host names without changing the on-disk shape', () => {
    for (const host of knownHosts) {
      saveHostSession(host, { sessionId: `${host}-session` });
    }

    for (const host of knownHosts) {
      expect(loadHostSession(host)!.sessionId).toBe(`${host}-session`);
    }

    const raw = JSON.parse(readFileSync(hostSessionStoragePath(), 'utf-8'));
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.sessions).sort()).toEqual([...knownHosts].sort());
  });

  it('keeps hosts isolated', () => {
    saveHostSession('claudecode', { sessionId: 'c-1' });
    saveHostSession('codex', { sessionId: 'x-1' });
    saveHostSession('openclaw', { sessionId: 'o-1' });
    expect(loadHostSession('claudecode')!.sessionId).toBe('c-1');
    expect(loadHostSession('codex')!.sessionId).toBe('x-1');
    expect(loadHostSession('openclaw')!.sessionId).toBe('o-1');
  });

  it('preserves optional resume mode and host metadata', () => {
    saveHostSession('openclaw', {
      sessionId: 'oc-session',
      resumeMode: 'wake',
      hostMetadata: { sessionKey: 'oc-session', surface: 'operator' },
    });

    const got = loadHostSession('openclaw');
    expect(got).not.toBeNull();
    expect(got!.resumeMode).toBe('wake');
    expect(got!.hostMetadata).toEqual({ sessionKey: 'oc-session', surface: 'operator' });
  });

  it('overwrites the same host on second save (last wins)', () => {
    saveHostSession('codex', { sessionId: 'old' });
    saveHostSession('codex', { sessionId: 'new' });
    expect(loadHostSession('codex')!.sessionId).toBe('new');
  });

  it('returns null when no record exists', () => {
    expect(loadHostSession('claudecode')).toBeNull();
  });

  it('skips a save with empty sessionId', () => {
    saveHostSession('codex', { sessionId: '' });
    expect(loadHostSession('codex')).toBeNull();
  });

  it('survives a corrupted JSON file', () => {
    // Seed the storage with garbage to simulate a torn write.
    saveHostSession('codex', { sessionId: 'ok' });
    writeFileSync(hostSessionStoragePath(), '{ not valid json');
    expect(loadHostSession('codex')).toBeNull();
    // Next save should recover the file shape cleanly.
    saveHostSession('codex', { sessionId: 'recovered' });
    expect(loadHostSession('codex')!.sessionId).toBe('recovered');
  });
});

describe('isSessionFresh', () => {
  it('treats a just-saved session as fresh', () => {
    const s = { sessionId: 'x', lastSeenMs: Date.now() };
    expect(isSessionFresh(s)).toBe(true);
  });

  it('treats a 25-hour-old session as stale by default', () => {
    const s = { sessionId: 'x', lastSeenMs: Date.now() - 25 * 60 * 60 * 1000 };
    expect(isSessionFresh(s)).toBe(false);
  });

  it('honors a custom maxAgeMs', () => {
    const s = { sessionId: 'x', lastSeenMs: Date.now() - 30 * 1000 };
    expect(isSessionFresh(s, 10 * 1000)).toBe(false);
    expect(isSessionFresh(s, 60 * 1000)).toBe(true);
  });

  it('rejects a session with non-finite timestamp', () => {
    expect(isSessionFresh({ sessionId: 'x', lastSeenMs: NaN })).toBe(false);
  });

  it('DEFAULT_SESSION_MAX_AGE_MS is 24h', () => {
    expect(DEFAULT_SESSION_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('loadHostSession age gate', () => {
  it('returns null when the saved session is older than maxAgeMs', () => {
    saveHostSession('codex', { sessionId: 'old-one' });
    // Manually backdate the saved record to 48h ago.
    const raw = readFileSync(hostSessionStoragePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    parsed.sessions.codex.lastSeenMs = Date.now() - 48 * 60 * 60 * 1000;
    writeFileSync(hostSessionStoragePath(), JSON.stringify(parsed));
    expect(loadHostSession('codex')).toBeNull();
  });

  it('returns the session when the gate is generous enough', () => {
    saveHostSession('codex', { sessionId: 'recent' });
    expect(loadHostSession('codex', 60 * 60 * 1000)).not.toBeNull();
  });
});

describe('forgetHostSession', () => {
  it('removes only the named host', () => {
    saveHostSession('claudecode', { sessionId: 'c' });
    saveHostSession('codex', { sessionId: 'x' });
    saveHostSession('openclaw', { sessionId: 'o' });
    forgetHostSession('codex');
    expect(loadHostSession('claudecode')).not.toBeNull();
    expect(loadHostSession('codex')).toBeNull();
    expect(loadHostSession('openclaw')).not.toBeNull();
  });

  it('is a no-op when no record exists', () => {
    expect(() => forgetHostSession('claudecode')).not.toThrow();
  });
});
