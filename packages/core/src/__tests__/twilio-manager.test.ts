import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createTestDatabase } from '../storage/db.js';
import {
  PhoneManager,
  buildPhoneTransportConfig,
  redactPhoneTransportConfig,
  type OpenClawPhoneMissionPolicy,
} from '../index.js';

// Webhook secret must clear the 24-char entropy floor (#43-H8).
const WEBHOOK_SECRET = 'twilio-hook-secret-abcdefghijkl';
const ACCOUNT_SID = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const AUTH_TOKEN = 'twilio-auth-token-abcdefghijklmn';

/** Recompute the per-mission webhook token (#43-H7) the manager emits. */
function tokenFor(missionId: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(missionId).digest('hex');
}

const policy: OpenClawPhoneMissionPolicy = {
  policyVersion: 1,
  regionAllowlist: ['WORLD'],
  maxCallDurationSeconds: 600,
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

function twilioConfig() {
  return buildPhoneTransportConfig({
    provider: 'twilio',
    phoneNumber: '+15550001111',
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    webhookBaseUrl: 'https://agenticmail.example.com',
    webhookSecret: WEBHOOK_SECRET,
    supportedRegions: ['WORLD'],
  });
}

describe('buildPhoneTransportConfig — Twilio', () => {
  it('builds a Twilio config from accountSid / authToken aliases', () => {
    const cfg = twilioConfig();
    expect(cfg.provider).toBe('twilio');
    expect(cfg.username).toBe(ACCOUNT_SID);
    expect(cfg.password).toBe(AUTH_TOKEN);
  });

  it('also accepts the generic username / password keys', () => {
    const cfg = buildPhoneTransportConfig({
      provider: 'twilio',
      phoneNumber: '+15550001111',
      username: ACCOUNT_SID,
      password: AUTH_TOKEN,
      webhookBaseUrl: 'https://agenticmail.example.com',
      webhookSecret: WEBHOOK_SECRET,
      supportedRegions: ['WORLD'],
    });
    expect(cfg.username).toBe(ACCOUNT_SID);
  });

  it('rejects a Twilio config missing credentials', () => {
    expect(() => buildPhoneTransportConfig({
      provider: 'twilio',
      phoneNumber: '+15550001111',
      webhookBaseUrl: 'https://agenticmail.example.com',
      webhookSecret: WEBHOOK_SECRET,
    })).toThrow(/accountSid and authToken are required/);
  });

  it('rejects an unknown provider', () => {
    expect(() => buildPhoneTransportConfig({
      provider: 'vonage',
      phoneNumber: '+15550001111',
      username: 'u',
      password: 'p',
      webhookBaseUrl: 'https://agenticmail.example.com',
      webhookSecret: WEBHOOK_SECRET,
    })).toThrow(/"46elks" or "twilio"/);
  });

  it('still enforces the webhook-secret entropy floor (#43-H8)', () => {
    expect(() => buildPhoneTransportConfig({
      provider: 'twilio',
      phoneNumber: '+15550001111',
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      webhookBaseUrl: 'https://agenticmail.example.com',
      webhookSecret: 'short',
    })).toThrow(/at least 24 characters/);
  });
});

describe('PhoneManager — Twilio outbound calls', () => {
  const dbs: ReturnType<typeof createTestDatabase>[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    vi.unstubAllGlobals();
  });

  it('stores a Twilio transport config and redacts the auth token', () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db, 'mk_test_key');
    manager.savePhoneTransportConfig('agent1', twilioConfig());

    const loaded = manager.getPhoneTransportConfig('agent1');
    expect(loaded).toMatchObject({ provider: 'twilio', username: ACCOUNT_SID, password: AUTH_TOKEN });
    expect(redactPhoneTransportConfig(loaded!).password).toBe('***');
    const raw = db.prepare('SELECT metadata FROM agents WHERE id = ?').get('agent1') as { metadata: string };
    expect(raw.metadata).not.toContain(AUTH_TOKEN);
  });

  it('builds a Calls.json dry-run request with the right URL, From/To and webhook URLs', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', twilioConfig());

    const result = await manager.startMission('agent1', {
      to: '+15550009999',
      task: 'Confirm the booking',
      policy,
    }, { dryRun: true });

    expect(result.mission.status).toBe('dialing');
    expect(result.mission.providerCallId).toBe('dryrun-call');
    expect(result.providerRequest?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`,
    );
    expect(result.providerRequest?.body).toMatchObject({
      From: '+15550001111',
      To: '+15550009999',
      TimeLimit: '600',
    });
    expect(result.providerRequest?.body.Url).toContain('/calls/webhook/twilio/voice');
    expect(result.providerRequest?.body.StatusCallback).toContain('/calls/webhook/twilio/status');
    // The webhook URLs carry the per-mission token, never the raw secret.
    expect(result.providerRequest?.body.Url).toContain(`token=${tokenFor(result.mission.id)}`);
    expect(String(result.mission.metadata.providerRequest)).not.toContain(WEBHOOK_SECRET);
  });

  it('posts a Twilio Calls.json request with Basic auth + form encoding', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', twilioConfig());

    // Twilio's Calls.json returns the call SID under `sid`.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      sid: 'CA-twilio-call', status: 'queued',
    }), { status: 201 }));

    const result = await manager.startMission('agent1', {
      to: '+15550009999',
      task: 'Confirm the booking',
      policy,
    }, { fetchFn: fetchMock as unknown as typeof fetch });

    // The `sid` from the response is captured as the provider call id.
    expect(result.mission.providerCallId).toBe('CA-twilio-call');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const body = new URLSearchParams(String(init.body));
    expect(body.get('From')).toBe('+15550001111');
    expect(body.get('To')).toBe('+15550009999');
  });

  it('marks the mission failed when the Twilio request throws (fail-closed #43-H4)', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', twilioConfig());

    const fetchMock = vi.fn(async () => { throw new Error('network down'); });
    await expect(manager.startMission('agent1', {
      to: '+15550009999', task: 'Confirm the booking', policy,
    }, { fetchFn: fetchMock as unknown as typeof fetch })).rejects.toThrow(/network down/);

    const missions = manager.listMissions('agent1');
    expect(missions[0].status).toBe('failed');
    expect(missions[0].metadata.providerError).toBe('network down');
  });

  it('resolves the Twilio call by its provider call id', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', twilioConfig());
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: 'CA-find-me' }), { status: 201 }));
    await manager.startMission('agent1', { to: '+15550009999', task: 'call', policy },
      { fetchFn: fetchMock as unknown as typeof fetch });

    expect(manager.findMissionByProviderCallId('CA-find-me')?.agentId).toBe('agent1');
    expect(manager.findMissionByProviderCallId('CA-unknown')).toBeNull();
  });
});

describe('PhoneManager — Twilio webhooks', () => {
  const dbs: ReturnType<typeof createTestDatabase>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  async function startDryRun(manager: PhoneManager) {
    manager.savePhoneTransportConfig('agent1', twilioConfig());
    const { mission } = await manager.startMission('agent1', {
      to: '+15550009999', task: 'Confirm the booking', policy,
    }, { dryRun: true });
    return mission;
  }

  it('returns Connect/Stream TwiML from the voice webhook and rejects forged tokens', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    const mission = await startDryRun(manager);
    const token = tokenFor(mission.id);

    // Forged token, raw secret, unknown mission all fail uniformly (#43-H3).
    expect(() => manager.handleTwilioVoiceWebhook(mission.id, 'wrong')).toThrow();
    expect(() => manager.handleTwilioVoiceWebhook(mission.id, WEBHOOK_SECRET)).toThrow();
    expect(() => manager.handleTwilioVoiceWebhook('call_nope', token)).toThrow();

    const voice = manager.handleTwilioVoiceWebhook(mission.id, token, { CallSid: 'CA1' });
    expect(voice.mission.status).toBe('connected');
    expect(voice.twiml).toContain('<Connect>');
    expect(voice.twiml).toContain('<Stream url=');
    // The stream URL points at the Twilio realtime path and is wss://.
    expect(voice.twiml).toContain('calls/twilio-stream');
    expect(voice.twiml).toContain('wss://');
    // The per-mission token rides into the TwiML, never the raw secret.
    expect(voice.twiml).toContain(token);
    expect(voice.twiml).not.toContain(WEBHOOK_SECRET);
  });

  it('records the status callback as the hangup-equivalent and accumulates cost', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    const mission = await startDryRun(manager);
    const token = tokenFor(mission.id);

    // Twilio reports the price as a negative debit; the absolute value
    // is accumulated against the mission.
    const status = manager.handleTwilioStatusWebhook(mission.id, token, {
      CallSid: 'CA1', CallStatus: 'completed', CallDuration: '42', Price: '-0.013',
    });
    expect(status.status).toBe('failed');
    expect(status.metadata.hangupReason).toBe('call-ended-before-conversation-runtime');
    expect(status.metadata.totalCost).toBeCloseTo(0.013, 6);

    // A duplicate status callback is idempotent.
    const before = status.transcript.length;
    const dup = manager.handleTwilioStatusWebhook(mission.id, token, {
      CallSid: 'CA1', CallStatus: 'completed', CallDuration: '42', Price: '-0.013',
    });
    expect(dup.transcript).toHaveLength(before);
  });

  it('does not resurrect a terminal mission from a late voice webhook (#43-H5)', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    const mission = await startDryRun(manager);
    const token = tokenFor(mission.id);

    manager.cancelMission('agent1', mission.id);
    const late = manager.handleTwilioVoiceWebhook(mission.id, token, { CallSid: 'CA1' });
    expect(late.mission.status).toBe('cancelled');
    // The TwiML is still returned so Twilio gets a valid response.
    expect(late.twiml).toContain('<Response>');
  });
});
