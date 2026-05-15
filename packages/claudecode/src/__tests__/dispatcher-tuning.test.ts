/**
 * Tests for the dispatcher-tuning module — env / file / explicit
 * precedence + idempotent atomic writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDispatcherTuning,
  writeDispatcherTuning,
} from '../dispatcher-tuning.js';

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amcc-tune-'));
  cfgPath = join(dir, 'dispatcher.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveDispatcherTuning', () => {
  it('returns all-undefined when nothing is configured', () => {
    const r = resolveDispatcherTuning({ env: {}, configPath: cfgPath });
    expect(r.maxConcurrentWorkers).toBeUndefined();
    expect(r.maxWakesPerThread).toBeUndefined();
    expect(r.wakeWindowMs).toBeUndefined();
    expect(r.wakeCoalesceMs).toBeUndefined();
    expect(r.accountSyncIntervalMs).toBeUndefined();
  });

  it('reads values from env vars', () => {
    const r = resolveDispatcherTuning({
      env: {
        AGENTICMAIL_DISPATCHER_MAX: '200',
        AGENTICMAIL_DISPATCHER_MAX_WAKES_PER_THREAD: '50',
        AGENTICMAIL_DISPATCHER_WAKE_WINDOW_MS: '60000',
        AGENTICMAIL_DISPATCHER_COALESCE_MS: '5000',
        AGENTICMAIL_DISPATCHER_SYNC: '10000',
      },
      configPath: cfgPath,
    });
    expect(r.maxConcurrentWorkers).toBe(200);
    expect(r.maxWakesPerThread).toBe(50);
    expect(r.wakeWindowMs).toBe(60000);
    expect(r.wakeCoalesceMs).toBe(5000);
    expect(r.accountSyncIntervalMs).toBe(10000);
  });

  it('reads values from the on-disk file', () => {
    writeFileSync(cfgPath, JSON.stringify({
      version: 1,
      maxConcurrentWorkers: 100,
      maxWakesPerThread: 25,
    }));
    const r = resolveDispatcherTuning({ env: {}, configPath: cfgPath });
    expect(r.maxConcurrentWorkers).toBe(100);
    expect(r.maxWakesPerThread).toBe(25);
  });

  it('env wins over file', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, maxConcurrentWorkers: 100 }));
    const r = resolveDispatcherTuning({
      env: { AGENTICMAIL_DISPATCHER_MAX: '500' },
      configPath: cfgPath,
    });
    expect(r.maxConcurrentWorkers).toBe(500);
  });

  it('explicit args win over env and file', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, maxConcurrentWorkers: 100 }));
    const r = resolveDispatcherTuning({
      explicit: { maxConcurrentWorkers: 999 },
      env: { AGENTICMAIL_DISPATCHER_MAX: '500' },
      configPath: cfgPath,
    });
    expect(r.maxConcurrentWorkers).toBe(999);
  });

  it('rejects non-positive numbers in env (falls through)', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, maxConcurrentWorkers: 100 }));
    const r = resolveDispatcherTuning({
      env: { AGENTICMAIL_DISPATCHER_MAX: '0' },
      configPath: cfgPath,
    });
    // env value invalid → falls back to file
    expect(r.maxConcurrentWorkers).toBe(100);
  });

  it('rejects negative numbers in env (falls through)', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, maxConcurrentWorkers: 100 }));
    const r = resolveDispatcherTuning({
      env: { AGENTICMAIL_DISPATCHER_MAX: '-5' },
      configPath: cfgPath,
    });
    expect(r.maxConcurrentWorkers).toBe(100);
  });

  it('ignores wrong-version files', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 99, maxConcurrentWorkers: 100 }));
    const r = resolveDispatcherTuning({ env: {}, configPath: cfgPath });
    expect(r.maxConcurrentWorkers).toBeUndefined();
  });

  it('ignores malformed JSON (returns undefined for everything)', () => {
    writeFileSync(cfgPath, '{not json');
    expect(() => resolveDispatcherTuning({ env: {}, configPath: cfgPath })).not.toThrow();
    const r = resolveDispatcherTuning({ env: {}, configPath: cfgPath });
    expect(r.maxConcurrentWorkers).toBeUndefined();
  });

  it('drops malformed individual values silently', () => {
    writeFileSync(cfgPath, JSON.stringify({
      version: 1,
      maxConcurrentWorkers: 'fifty',  // wrong type
      maxWakesPerThread: 25,          // valid
    }));
    const r = resolveDispatcherTuning({ env: {}, configPath: cfgPath });
    expect(r.maxConcurrentWorkers).toBeUndefined();
    expect(r.maxWakesPerThread).toBe(25);
  });
});

describe('writeDispatcherTuning', () => {
  it('writes a fresh file with version metadata', () => {
    const result = writeDispatcherTuning({ maxConcurrentWorkers: 100 }, cfgPath);
    expect(existsSync(cfgPath)).toBe(true);
    expect(result.version).toBe(1);
    expect(result.maxConcurrentWorkers).toBe(100);
    expect(typeof result.updatedAtMs).toBe('number');
  });

  it('preserves existing keys when patching only one', () => {
    writeDispatcherTuning({ maxConcurrentWorkers: 100, maxWakesPerThread: 50 }, cfgPath);
    writeDispatcherTuning({ maxConcurrentWorkers: 200 }, cfgPath);
    const reloaded = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(reloaded.maxConcurrentWorkers).toBe(200);
    expect(reloaded.maxWakesPerThread).toBe(50);
  });

  it('round-trips through resolveDispatcherTuning', () => {
    writeDispatcherTuning({
      maxConcurrentWorkers: 100,
      maxWakesPerThread: 25,
      wakeWindowMs: 60000,
      wakeCoalesceMs: 5000,
      accountSyncIntervalMs: 10000,
    }, cfgPath);
    const r = resolveDispatcherTuning({ env: {}, configPath: cfgPath });
    expect(r).toEqual({
      maxConcurrentWorkers: 100,
      maxWakesPerThread: 25,
      wakeWindowMs: 60000,
      wakeCoalesceMs: 5000,
      accountSyncIntervalMs: 10000,
    });
  });

  it('ignores non-positive patch values (preserves existing)', () => {
    writeDispatcherTuning({ maxConcurrentWorkers: 100 }, cfgPath);
    writeDispatcherTuning({ maxConcurrentWorkers: -5 }, cfgPath);
    const reloaded = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(reloaded.maxConcurrentWorkers).toBe(100);
  });

  it('creates parent directory if missing', () => {
    const nestedPath = join(dir, 'sub', 'nested', 'dispatcher.json');
    writeDispatcherTuning({ maxConcurrentWorkers: 100 }, nestedPath);
    expect(existsSync(nestedPath)).toBe(true);
  });
});
