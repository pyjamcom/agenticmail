import {
  BRIDGE_OPERATOR_LIVE_WINDOW_MS,
  bridgeWakeErrorMessage,
  bridgeWakeLastSeenAgeMs,
  classifyResumeError,
  composeBridgeWakePrompt,
  planBridgeWake,
  shouldSkipBridgeWakeForLiveOperator,
} from '../host-bridge.js';

describe('host-bridge', () => {
  it('composes a stable bridge wake prompt', () => {
    const prompt = composeBridgeWakePrompt({
      bridgeName: 'openclaw',
      uid: 42,
      from: 'sender@example.com',
      subject: 'Need a call',
      preview: 'Please check this reservation request.',
    });

    expect(prompt).toContain('Bridge mail arrived');
    expect(prompt).toContain('openclaw@localhost');
    expect(prompt).toContain('UID:     42');
    expect(prompt).toContain('From:    sender@example.com');
    expect(prompt).toContain('Subject: Need a call');
    expect(prompt).toContain('mcp__agenticmail__read_email({ uid: 42 })');
    expect(prompt).toContain('Keep this turn SHORT');
  });

  it('uses safe defaults and truncates long previews', () => {
    const prompt = composeBridgeWakePrompt({
      bridgeName: 'codex',
      uid: 7,
      preview: 'x'.repeat(700),
    });

    expect(prompt).toContain('From:    unknown');
    expect(prompt).toContain('Subject: (no subject)');
    expect(prompt).toContain(`Preview: ${'x'.repeat(600)}`);
    expect(prompt).not.toContain('x'.repeat(601));
  });

  it('classifies expired session and thread errors', () => {
    expect(classifyResumeError(new Error('session not found'))).toBe('session-expired');
    expect(classifyResumeError(new Error('thread expired'))).toBe('session-expired');
    expect(classifyResumeError(new Error('Cannot find module @openai/codex-sdk'))).toBe('sdk-missing');
    expect(classifyResumeError(new Error('rate limit'))).toBe('other');
  });

  it('can keep sdk-missing classification host-specific', () => {
    const error = new Error('command not found');
    expect(classifyResumeError(error)).toBe('sdk-missing');
    expect(classifyResumeError(error, { sdkMissingMarkers: [] })).toBe('other');
  });

  it('normalizes unknown error messages', () => {
    expect(bridgeWakeErrorMessage('plain failure')).toBe('plain failure');
  });

  it('detects live operators with a shared window', () => {
    const nowMs = 1_000_000;
    const live = { lastSeenMs: nowMs - BRIDGE_OPERATOR_LIVE_WINDOW_MS + 1 };
    const stale = { lastSeenMs: nowMs - BRIDGE_OPERATOR_LIVE_WINDOW_MS };

    expect(bridgeWakeLastSeenAgeMs(live, nowMs)).toBe(29_999);
    expect(shouldSkipBridgeWakeForLiveOperator(live, nowMs)).toBe(true);
    expect(shouldSkipBridgeWakeForLiveOperator(stale, nowMs)).toBe(false);
    expect(shouldSkipBridgeWakeForLiveOperator(null, nowMs)).toBe(false);
  });

  it('plans bridge wake routing decisions', () => {
    const nowMs = 1_000_000;
    const mail = {
      bridgeName: 'claudecode',
      uid: 123,
      subject: 'Bridge request',
      from: 'teammate@example.com',
      preview: 'Please handle this.',
    };

    expect(planBridgeWake({
      session: { sessionId: 'live', lastSeenMs: nowMs - 1_000 },
      mail,
      nowMs,
    })).toMatchObject({
      action: 'skip-live',
      reason: 'operator-live',
      ageMs: 1_000,
      mail,
    });

    expect(planBridgeWake({ session: null, mail, nowMs })).toMatchObject({
      action: 'escalate',
      reason: 'no-fresh-session',
      mail,
    });

    const resume = planBridgeWake({
      session: { sessionId: 'stale-enough', workspace: '/tmp/project', lastSeenMs: nowMs - 60_000 },
      mail,
      nowMs,
    });
    expect(resume).toMatchObject({
      action: 'resume',
      session: { sessionId: 'stale-enough', workspace: '/tmp/project' },
      mail,
    });
    expect(resume.action === 'resume' ? resume.prompt : '').toContain('Bridge request');
  });
});
