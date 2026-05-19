import { describe, expect, it, vi } from 'vitest';
import {
  buildOpenClawBridgeMailContext,
  handleOpenClawBridgeWake,
  isOpenClawBridgeAccount,
} from '../bridge-wake.js';
import type { HostSession } from '@agenticmail/core';

describe('OpenClaw bridge wake', () => {
  const email = {
    from: [{ address: 'worker@localhost' }],
    subject: 'Need operator decision',
    text: 'Please decide this one.',
  };

  const session: HostSession = {
    sessionId: 'agent:main',
    lastSeenMs: Date.now() - 60_000,
    resumeMode: 'wake-only',
  };

  it('detects the OpenClaw bridge account by name or localhost email', () => {
    expect(isOpenClawBridgeAccount({ name: 'openclaw' })).toBe(true);
    expect(isOpenClawBridgeAccount({ email: 'openclaw@localhost' })).toBe(true);
    expect(isOpenClawBridgeAccount({ name: 'secretary', email: 'secretary@localhost' })).toBe(false);
  });

  it('builds shared bridge mail context from an AgenticMail message', () => {
    expect(buildOpenClawBridgeMailContext(email, 42)).toEqual({
      bridgeName: 'openclaw',
      uid: 42,
      from: 'worker@localhost',
      subject: 'Need operator decision',
      preview: 'Please decide this one.',
    });
  });

  it('skips wake when the operator session is live', async () => {
    const enqueueSystemEvent = vi.fn();
    const outcome = await handleOpenClawBridgeWake({
      email,
      uid: 1,
      runtime: { system: { enqueueSystemEvent } },
      nowMs: 1_000,
      loadSession: () => ({ ...session, lastSeenMs: 990 }),
    });

    expect(outcome.action).toBe('skip-live');
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it('escalates when no fresh OpenClaw host session is known', async () => {
    const enqueueSystemEvent = vi.fn();
    const outcome = await handleOpenClawBridgeWake({
      email,
      uid: 2,
      runtime: { system: { enqueueSystemEvent } },
      loadSession: () => null,
    });

    expect(outcome).toEqual({ handled: true, action: 'escalate', uid: 2, reason: 'no-fresh-session' });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it('queues a system event against the saved OpenClaw session key', async () => {
    const enqueueSystemEvent = vi.fn();
    const outcome = await handleOpenClawBridgeWake({
      email,
      uid: 3,
      runtime: { system: { enqueueSystemEvent } },
      nowMs: 100_000,
      loadSession: () => ({ ...session, lastSeenMs: 1 }),
    });

    expect(outcome).toEqual({ handled: true, action: 'wake-queued', uid: 3, sessionKey: 'agent:main' });
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent.mock.calls[0][0]).toContain('Bridge mail arrived');
    expect(enqueueSystemEvent.mock.calls[0][1]).toEqual({ sessionKey: 'agent:main' });
  });

  it('dedupes in-flight wake attempts by UID', async () => {
    const inFlightUids = new Set<number>([4]);
    const enqueueSystemEvent = vi.fn();
    const outcome = await handleOpenClawBridgeWake({
      email,
      uid: 4,
      runtime: { system: { enqueueSystemEvent } },
      inFlightUids,
      loadSession: () => session,
    });

    expect(outcome).toEqual({ handled: true, action: 'duplicate', uid: 4 });
    expect(inFlightUids.has(4)).toBe(true);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it('escalates when OpenClaw cannot enqueue a targeted wake event', async () => {
    const outcome = await handleOpenClawBridgeWake({
      email,
      uid: 5,
      runtime: {},
      nowMs: 100_000,
      loadSession: () => ({ ...session, lastSeenMs: 1 }),
    });

    expect(outcome).toEqual({ handled: true, action: 'escalate', uid: 5, reason: 'wake-unavailable' });
  });
});
