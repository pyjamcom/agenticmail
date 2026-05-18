import { describe, expect, it } from 'vitest';
import {
  applySpawnMinTimeout,
  DEFAULT_SUBAGENT_MIN_TIMEOUT_SECONDS,
  resolveSpawnMinTimeoutSeconds,
} from '../../index.js';

describe('resolveSpawnMinTimeoutSeconds', () => {
  it('uses the 10-minute default when config is absent', () => {
    expect(resolveSpawnMinTimeoutSeconds(undefined)).toBe(DEFAULT_SUBAGENT_MIN_TIMEOUT_SECONDS);
    expect(resolveSpawnMinTimeoutSeconds({})).toBe(DEFAULT_SUBAGENT_MIN_TIMEOUT_SECONDS);
  });

  it('accepts lower configured minimums for quick sub-agent calls', () => {
    expect(resolveSpawnMinTimeoutSeconds({ spawnMinTimeoutSeconds: 60 })).toBe(60);
    expect(resolveSpawnMinTimeoutSeconds({ spawnMinTimeoutSeconds: '90' })).toBe(90);
  });

  it('allows zero to disable timeout enforcement', () => {
    expect(resolveSpawnMinTimeoutSeconds({ spawnMinTimeoutSeconds: 0 })).toBe(0);
    expect(resolveSpawnMinTimeoutSeconds({ spawnMinTimeoutSeconds: '0' })).toBe(0);
  });

  it('normalizes invalid values back to the safe default', () => {
    expect(resolveSpawnMinTimeoutSeconds({ spawnMinTimeoutSeconds: -1 })).toBe(DEFAULT_SUBAGENT_MIN_TIMEOUT_SECONDS);
    expect(resolveSpawnMinTimeoutSeconds({ spawnMinTimeoutSeconds: 'abc' })).toBe(DEFAULT_SUBAGENT_MIN_TIMEOUT_SECONDS);
    expect(resolveSpawnMinTimeoutSeconds({ spawnMinTimeoutSeconds: '   ' })).toBe(DEFAULT_SUBAGENT_MIN_TIMEOUT_SECONDS);
    expect(resolveSpawnMinTimeoutSeconds({ spawnMinTimeoutSeconds: true })).toBe(DEFAULT_SUBAGENT_MIN_TIMEOUT_SECONDS);
  });
});

describe('applySpawnMinTimeout', () => {
  it('raises lower timeouts to the configured minimum', () => {
    expect(applySpawnMinTimeout({ task: 'work', runTimeoutSeconds: 30 }, 60)).toEqual({
      task: 'work',
      runTimeoutSeconds: 60,
    });
  });

  it('leaves timeouts at or above the configured minimum unchanged', () => {
    expect(applySpawnMinTimeout({ runTimeoutSeconds: 60 }, 60)).toBeUndefined();
    expect(applySpawnMinTimeout({ runTimeoutSeconds: 120 }, 60)).toBeUndefined();
  });

  it('does not change timeout when enforcement is disabled', () => {
    expect(applySpawnMinTimeout({ runTimeoutSeconds: 30 }, 0)).toBeUndefined();
  });
});
