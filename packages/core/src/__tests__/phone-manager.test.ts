import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase } from '../storage/db.js';
import {
  PhoneManager,
  buildPhoneTransportConfig,
  redactPhoneTransportConfig,
  type OpenClawPhoneMissionPolicy,
} from '../index.js';

const policy: OpenClawPhoneMissionPolicy = {
  policyVersion: 1,
  regionAllowlist: ['AT', 'DE'],
  maxCallDurationSeconds: 300,
  maxCostPerMission: 5,
  maxAttempts: 1,
  transcriptEnabled: true,
  recordingEnabled: false,
  confirmPolicy: {
    paymentDetails: 'never',
    contractCommitment: 'never',
    costOverLimit: 'needs_operator',
    sensitivePersonalData: 'needs_operator',
    unclearAlternative: 'needs_operator',
  },
  alternativePolicy: { maxTimeShiftMinutes: 30 },
};

function createDb() {
  const db = createTestDatabase();
  db.prepare(`
    INSERT INTO agents (id, name, email, api_key, stalwart_principal, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('agent1', 'ralf', 'ralf@example.com', 'ak_test', 'principal1', '{}');
  return db;
}

function phoneConfig() {
  return buildPhoneTransportConfig({
    provider: '46elks',
    phoneNumber: '+43123456789',
    username: 'user',
    password: 'api-password-secret',
    webhookBaseUrl: 'https://agenticmail.example.com',
    webhookSecret: 'hook-secret',
    supportedRegions: ['AT', 'DE'],
  });
}

describe('PhoneManager', () => {
  const dbs: ReturnType<typeof createTestDatabase>[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    vi.unstubAllGlobals();
  });

  it('stores phone transport config and redacts secrets for output', () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db, 'mk_test_key');

    const cfg = phoneConfig();
    manager.savePhoneTransportConfig('agent1', cfg);

    const loaded = manager.getPhoneTransportConfig('agent1');
    expect(loaded).toMatchObject({
      provider: '46elks',
      phoneNumber: '+43123456789',
      username: 'user',
      password: 'api-password-secret',
      webhookSecret: 'hook-secret',
    });
    expect(redactPhoneTransportConfig(loaded!).password).toBe('***');
    const raw = db.prepare('SELECT metadata FROM agents WHERE id = ?').get('agent1') as { metadata: string };
    expect(raw.metadata).not.toContain('hook-secret');
    expect(raw.metadata).not.toContain('api-password-secret');
  });

  it('starts a dry-run mission without calling the provider', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', phoneConfig());

    const result = await manager.startMission('agent1', {
      to: '+436641234567',
      task: 'Reserve a table',
      policy,
    }, { dryRun: true, now: new Date('2026-05-18T20:00:00.000Z') });

    expect(result.mission.status).toBe('dialing');
    expect(result.mission.providerCallId).toBe('dryrun-call');
    expect(result.providerRequest?.url).toBe('https://api.46elks.com/a1/calls');
    expect(result.providerRequest?.body).toMatchObject({
      from: '+43123456789',
      to: '+436641234567',
      timeout: '300',
    });
    expect(String(result.mission.metadata.providerRequest)).not.toContain('hook-secret');
  });

  it('posts a 46elks call-control request with form encoding', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', phoneConfig());

    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      id: 'call123',
      status: 'created',
    }), { status: 200 }));

    const result = await manager.startMission('agent1', {
      to: '+436641234567',
      task: 'Reserve a table',
      policy,
    }, { fetchFn: fetchMock as unknown as typeof fetch });

    expect(result.mission.providerCallId).toBe('call123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.46elks.com/a1/calls');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('user:api-password-secret').toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const body = new URLSearchParams(String(init.body));
    expect(body.get('from')).toBe('+43123456789');
    expect(body.get('to')).toBe('+436641234567');
    expect(body.get('voice_start')).toContain('/api/agenticmail/calls/webhook/46elks/voice-start');
    expect(body.get('whenhangup')).toContain('/api/agenticmail/calls/webhook/46elks/hangup');
  });

  it('rejects forged webhooks and records valid voice-start/hangup events', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', phoneConfig());
    const { mission } = await manager.startMission('agent1', {
      to: '+436641234567',
      task: 'Reserve a table',
      policy,
    }, { dryRun: true });

    expect(() => manager.handleVoiceStartWebhook(mission.id, 'wrong')).toThrow(/secret/i);

    const voiceStart = manager.handleVoiceStartWebhook(mission.id, 'hook-secret', { callid: 'call123' });
    expect(voiceStart.mission.status).toBe('connected');
    expect(voiceStart.action.play).toContain('AgenticMail');
    const voiceStartTranscriptLength = voiceStart.mission.transcript.length;

    const duplicateVoiceStart = manager.handleVoiceStartWebhook(mission.id, 'hook-secret', { callid: 'call123' });
    expect(duplicateVoiceStart.mission.transcript).toHaveLength(voiceStartTranscriptLength);

    const hangup = manager.handleHangupWebhook(mission.id, 'hook-secret', { callid: 'call123' });
    expect(hangup.status).toBe('failed');
    expect(hangup.metadata.hangupReason).toBe('call-ended-before-conversation-runtime');
    expect(hangup.metadata.phoneWebhookEvents).toHaveLength(2);
    const hangupTranscriptLength = hangup.transcript.length;

    const duplicateHangup = manager.handleHangupWebhook(mission.id, 'hook-secret', { callid: 'call123' });
    expect(duplicateHangup.transcript).toHaveLength(hangupTranscriptLength);
    expect(duplicateHangup.metadata.phoneWebhookEvents).toHaveLength(2);
  });
});
