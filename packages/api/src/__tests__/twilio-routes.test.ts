import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  createTestDatabase,
  PhoneManager,
  buildTwilioSignature,
  type AgenticMailConfig,
} from '@agenticmail/core';
import { createHmac } from 'node:crypto';
import { createPhoneRoutes, createPhoneWebhookRoutes } from '../routes/phone.js';

const WEBHOOK_SECRET = 'twilio-hook-secret-abcdefghijkl';
const ACCOUNT_SID = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const AUTH_TOKEN = 'twilio-auth-token-abcdefghijklmn';
const WEBHOOK_BASE = 'https://agenticmail.example.com';

function tokenFor(missionId: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(missionId).digest('hex');
}

const policy = {
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

const config = { masterKey: 'mk_test_key' } as AgenticMailConfig;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bad address');
  return `http://127.0.0.1:${address.port}`;
}

function createDb() {
  const db = createTestDatabase();
  db.prepare(`
    INSERT INTO agents (id, name, email, api_key, stalwart_principal, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('agent1', 'ralf', 'ralf@example.com', 'ak_test', 'principal1', '{}');
  return db;
}

function createApp(db: ReturnType<typeof createTestDatabase>): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).agent = { id: 'agent1', email: 'ralf@example.com' }; next(); });
  app.use(createPhoneWebhookRoutes(db, config));
  app.use(createPhoneRoutes(db, config));
  return app;
}

async function setupTwilioTransport(db: ReturnType<typeof createTestDatabase>) {
  // Configure the transport directly via the manager — the route-level
  // setup is exercised by the 46elks tests; here we want to focus on
  // the Twilio webhook signature path.
  const manager = new PhoneManager(db as any, config.masterKey);
  manager.savePhoneTransportConfig('agent1', {
    provider: 'twilio',
    phoneNumber: '+15550001111',
    username: ACCOUNT_SID,
    password: AUTH_TOKEN,
    webhookBaseUrl: WEBHOOK_BASE,
    webhookSecret: WEBHOOK_SECRET,
    apiUrl: undefined,
    capabilities: ['call_control'],
    supportedRegions: ['WORLD'],
    configuredAt: new Date().toISOString(),
  });
  const { mission } = await manager.startMission('agent1', {
    to: '+15550009999', task: 'Confirm the booking', policy: policy as any,
  }, { dryRun: true });
  return mission;
}

/**
 * POST a form-encoded request to a Twilio webhook, signing it the way
 * Twilio would. `signed: false` deliberately sends a bad signature.
 */
async function postTwilioWebhook(
  baseUrl: string,
  path: string,
  missionId: string,
  params: Record<string, string>,
  opts: { signed?: boolean } = {},
): Promise<{ status: number; text: string }> {
  // The signed URL is the externally-configured URL Twilio would have
  // requested — rooted at the agent's webhookBaseUrl, not the test host.
  const externalUrl = `${WEBHOOK_BASE}${path}?missionId=${missionId}&token=${tokenFor(missionId)}`;
  const signature = (opts.signed ?? true)
    ? buildTwilioSignature(AUTH_TOKEN, externalUrl, params)
    : 'deliberately-wrong-signature';
  const res = await fetch(`${baseUrl}${path}?missionId=${missionId}&token=${tokenFor(missionId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
      // The route reconstructs the signed URL from webhookBaseUrl, so
      // the Host header here is irrelevant — set it to prove that.
      Host: 'agenticmail.example.com',
    },
    body: new URLSearchParams(params),
  });
  return { status: res.status, text: await res.text() };
}

describe('Twilio webhook routes', () => {
  it('returns Connect/Stream TwiML from the voice webhook for a correctly-signed request', async () => {
    const db = createDb();
    const baseUrl = await listen(createApp(db));
    const mission = await setupTwilioTransport(db);

    const params = { CallSid: 'CA1', From: '+15550001111', To: '+15550009999', CallStatus: 'in-progress' };
    const res = await postTwilioWebhook(baseUrl, '/calls/webhook/twilio/voice', mission.id, params);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Connect>');
    expect(res.text).toContain('<Stream url=');
    expect(res.text).toContain('calls/twilio-stream');

    db.close();
  });

  it('rejects a Twilio voice webhook with a forged X-Twilio-Signature (fail-closed)', async () => {
    const db = createDb();
    const baseUrl = await listen(createApp(db));
    const mission = await setupTwilioTransport(db);

    const params = { CallSid: 'CA1', From: '+15550001111', To: '+15550009999' };
    const res = await postTwilioWebhook(baseUrl, '/calls/webhook/twilio/voice', mission.id, params, { signed: false });
    // Uniform 403 — same as a forged per-mission token (#43-H3).
    expect(res.status).toBe(403);
    expect(res.text).not.toContain('<Stream');

    db.close();
  });

  it('rejects a Twilio webhook for an unknown mission with the same uniform 403', async () => {
    const db = createDb();
    const baseUrl = await listen(createApp(db));
    await setupTwilioTransport(db);

    const params = { CallSid: 'CA1' };
    const res = await postTwilioWebhook(baseUrl, '/calls/webhook/twilio/voice', 'call_does-not-exist', params);
    expect(res.status).toBe(403);

    db.close();
  });

  it('records the Twilio status callback as the hangup-equivalent', async () => {
    const db = createDb();
    const baseUrl = await listen(createApp(db));
    const mission = await setupTwilioTransport(db);

    const params = { CallSid: 'CA1', CallStatus: 'completed', CallDuration: '37', Price: '-0.011' };
    const res = await postTwilioWebhook(baseUrl, '/calls/webhook/twilio/status', mission.id, params);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).mission.status).toBe('failed');

    // A status callback with a bad signature is refused.
    const forged = await postTwilioWebhook(baseUrl, '/calls/webhook/twilio/status', mission.id, params, { signed: false });
    expect(forged.status).toBe(403);

    db.close();
  });
});
