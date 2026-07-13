import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { AgentMemoryManager, createTestDatabase, PhoneManager, type AgenticMailConfig } from '@agenticmail/core';
import { createPhoneRoutes, createPhoneWebhookRoutes } from '../routes/phone.js';

// Webhook secret must clear the 24-char entropy floor (#43-H8).
const WEBHOOK_SECRET = 'hook-secret-abcdefghijklmnop';

/** Recompute the per-mission webhook token (#43-H7) the manager emits. */
function tokenFor(missionId: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(missionId).digest('hex');
}

const policy = {
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

const config = { masterKey: 'mk_test_key' } as AgenticMailConfig;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected server address');
  return `http://127.0.0.1:${address.port}`;
}

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  return { status: res.status, body: await res.json() };
}

function createDb() {
  const db = createTestDatabase();
  db.prepare(`
    INSERT INTO agents (id, name, email, api_key, stalwart_principal, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('agent1', 'ralf', 'ralf@example.com', 'ak_test', 'principal1', '{}');
  return db;
}

function createPhoneApp(db: ReturnType<typeof createTestDatabase>): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.agent = { id: 'agent1', email: 'ralf@example.com' };
    next();
  });
  app.use(createPhoneWebhookRoutes(db, config));
  app.use(createPhoneRoutes(db, config));
  return app;
}

function createSipPhoneApp(db: ReturnType<typeof createTestDatabase>): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isMaster = true;
    next();
  });
  app.use(createPhoneRoutes(db, config));
  return app;
}

async function setupTransport(baseUrl: string) {
  return request(baseUrl, '/phone/transport/setup', {
    method: 'POST',
    body: JSON.stringify({
      provider: '46elks',
      phoneNumber: '+43123456789',
      username: 'user',
      password: 'api-password-secret',
      webhookBaseUrl: 'https://agenticmail.example.com',
      webhookSecret: WEBHOOK_SECRET,
      supportedRegions: ['AT', 'DE'],
    }),
  });
}

describe('phone routes', () => {
  it('persists direct SIP transcript turns through the master-only API', async () => {
    const db = createDb();
    const baseUrl = await listen(createSipPhoneApp(db));
    const registered = await request(baseUrl, '/calls/sip/inbound', {
      method: 'POST',
      body: JSON.stringify({
        agent: 'ralf@example.com',
        providerCallId: 'sha256:route-test',
        from: 'sha256:caller',
        to: 'extension:redacted',
        callerContact: '+12025550999',
      }),
    });
    expect(registered.status).toBe(201);
    expect(registered.body.mission.provider).toBe('sip');

    const missionId = registered.body.mission.id;
    const persisted = await request(baseUrl, `/calls/sip/${missionId}/transcript`, {
      method: 'POST',
      body: JSON.stringify({
        entries: [
          {
            at: '2026-07-10T10:00:05.000Z',
            source: 'provider',
            text: 'Please prepare a quotation.',
            metadata: { eventId: 'route-turn-1' },
          },
          {
            at: '2026-07-10T10:00:06.000Z',
            source: 'agent',
            text: 'I will record the request for the sales manager.',
            metadata: { eventId: 'route-turn-2' },
          },
        ],
      }),
    });
    expect(persisted.status).toBe(200);
    const transcriptRead = await request(baseUrl, `/calls/sip/${missionId}/transcript`);
    expect(transcriptRead.status).toBe(200);
    expect(transcriptRead.body.transcript.map((entry: any) => entry.text))
      .toContain('Please prepare a quotation.');

    const intake = await request(baseUrl, `/calls/sip/${missionId}/intake`, {
      method: 'PATCH',
      body: JSON.stringify({
        patch: {
          relationship: 'new_customer',
          requestType: 'service',
          serviceTopic: 'other',
          requestDescription: 'Please prepare a quotation.',
          contactName: 'Test Contact',
          email: 'caller@example.test',
          callbackPhone: '+12025550123',
          nextAction: { type: 'manager_follow_up' },
        },
      }),
    });
    expect(intake.status).toBe(200);
    expect(intake.body.followupTaskId).toBeTruthy();
    const contact = await request(baseUrl, `/calls/sip/${missionId}/contact-secrets`);
    expect(contact.body.contact).toEqual({
      email: 'caller@example.test',
      callbackPhone: '+12025550123',
      callerNumber: '+12025550999',
    });
    const rawMetadata = db.prepare('SELECT metadata_json FROM phone_missions WHERE id = ?')
      .get(missionId) as { metadata_json: string };
    expect(rawMetadata.metadata_json).not.toContain('caller@example.test');
    expect(rawMetadata.metadata_json).not.toContain('+12025550123');
    expect(rawMetadata.metadata_json).not.toContain('+12025550999');

    const memory = new AgentMemoryManager(db as any);
    const verifiedContent = 'Verified process: quotations are reviewed by a sales manager before commitment.';
    const verifiedHash = createHash('sha256').update(verifiedContent, 'utf8').digest('hex');
    const verifiedMemory = await memory.storeMemory('agent1', {
      content: verifiedContent,
      title: 'Quotation review policy',
      category: 'knowledge',
      confidence: 1,
      tags: [
        'nevsky-broker-voice-context-v1',
        'context-key:test-quotation-review',
        `content-sha256:${verifiedHash}`,
        'source-version:nevsky-broker-voice-context-v1',
      ],
    });
    await memory.storeMemory('agent1', {
      content: 'Superseded website claim that must not reach the voice agent.',
      title: 'Quotation review policy legacy copy',
      category: 'knowledge',
      confidence: 1,
      tags: ['nevsky-broker-voice-kb-20260710'],
    });
    const knowledge = await request(baseUrl, `/calls/sip/${missionId}/knowledge`, {
      method: 'POST',
      body: JSON.stringify({ query: 'quotation review' }),
    });
    expect(knowledge.status).toBe(200);
    expect(knowledge.body.count).toBe(1);
    expect(knowledge.body.facts[0].content).toContain('reviewed by a sales manager');
    expect(knowledge.body.facts[0].knowledgeTrace).toBeUndefined();
    const knowledgeTranscript = await request(baseUrl, `/calls/sip/${missionId}/transcript`);
    const traceEntry = knowledgeTranscript.body.transcript.find(
      (entry: any) => entry.metadata?.kind === 'knowledge_lookup',
    );
    expect(traceEntry.metadata.factCount).toBe(1);
    expect(traceEntry.metadata.knowledgeTrace).toEqual([{
      recordId: verifiedMemory.id,
      contextKey: 'test-quotation-review',
      contentSha256: verifiedHash,
      sourceVersion: 'nevsky-broker-voice-context-v1',
    }]);
    const negativeKnowledge = await request(baseUrl, `/calls/sip/${missionId}/knowledge`, {
      method: 'POST',
      body: JSON.stringify({ query: 'borscht weather cinema' }),
    });
    expect(negativeKnowledge.body.count).toBe(0);
    const negativeTranscript = await request(baseUrl, `/calls/sip/${missionId}/transcript`);
    const traceEntries = negativeTranscript.body.transcript.filter(
      (entry: any) => entry.metadata?.kind === 'knowledge_lookup',
    );
    expect(traceEntries.at(-1).metadata).toMatchObject({ factCount: 0, knowledgeTrace: [] });

    const followups = await request(baseUrl, '/calls/sip/followups/pending');
    expect(followups.body.tasks).toHaveLength(1);
    expect(followups.body.tasks[0].missionId).toBe(missionId);
    const completedFollowup = await request(
      baseUrl,
      `/calls/sip/followups/${intake.body.followupTaskId}/complete`,
      { method: 'POST', body: '{}' },
    );
    expect(completedFollowup.status).toBe(200);

    const finalized = await request(baseUrl, `/calls/sip/${missionId}/finalize`, {
      method: 'POST',
      body: JSON.stringify({ status: 'completed', reason: 'remote_bye' }),
    });
    expect(finalized.status).toBe(200);
    expect(finalized.body.mission.status).toBe('completed');
    expect(finalized.body.mission.transcript).toEqual([]);
    expect(finalized.body.transcriptCount).toBeGreaterThan(0);
    expect(finalized.body.knowledgeArchiveStatus).toBe('pending');
    expect(finalized.body.transcriptEmailStatus).toBe('pending');
    const finalizedTranscript = await request(baseUrl, `/calls/sip/${missionId}/transcript`);
    expect(finalizedTranscript.body.transcript.map((entry: any) => entry.text))
      .toContain('Please prepare a quotation.');
    expect(finalizedTranscript.body.direction).toBe('inbound');
    const transcriptEmails = await request(baseUrl, '/calls/sip/transcript-emails/pending');
    expect(transcriptEmails.body.emails).toHaveLength(1);
    expect(transcriptEmails.body.emails[0].missionId).toBe(missionId);
    expect(transcriptEmails.body.emails[0].subject).toContain(missionId);
    expect(transcriptEmails.body.emails[0].textBody).toContain('Клиент: Please prepare a quotation.');
    expect(transcriptEmails.body.emails[0].textBody)
      .toContain('Елена: I will record the request for the sales manager.');
    expect(transcriptEmails.body.emails[0].textBody).not.toContain('Verified knowledge lookup recorded');
    const transcriptEmailEnqueued = await request(
      baseUrl,
      `/calls/sip/transcript-emails/${missionId}/enqueue`,
      { method: 'POST', body: '{}' },
    );
    expect(transcriptEmailEnqueued.body.delivery).toMatchObject({
      missionId,
      status: 'pending',
      attempts: 0,
    });
    const transcriptEmailFailed = await request(
      baseUrl,
      `/calls/sip/transcript-emails/${missionId}/failed`,
      { method: 'POST', body: JSON.stringify({ errorType: 'ExchangeUnavailable' }) },
    );
    expect(transcriptEmailFailed.status).toBe(200);
    const transcriptEmailNotDue = await request(baseUrl, '/calls/sip/transcript-emails/pending');
    expect(transcriptEmailNotDue.body.emails).toHaveLength(0);
    db.prepare("UPDATE sip_transcript_email_delivery SET next_attempt_at = datetime('now', '-1 second') WHERE mission_id = ?")
      .run(missionId);
    const transcriptEmailRetry = await request(baseUrl, '/calls/sip/transcript-emails/pending');
    expect(transcriptEmailRetry.body.emails).toHaveLength(1);
    const transcriptEmailDelivered = await request(
      baseUrl,
      `/calls/sip/transcript-emails/${missionId}/delivered`,
      { method: 'POST', body: JSON.stringify({ exchangeRefHash: 'sha256:transcript-email' }) },
    );
    expect(transcriptEmailDelivered.status).toBe(200);
    const transcriptEmailStatus = await request(
      baseUrl,
      `/calls/sip/transcript-emails/${missionId}/status`,
    );
    expect(transcriptEmailStatus.body.delivery).toMatchObject({
      missionId,
      status: 'delivered',
      attempts: 2,
      exchangeRefHash: 'sha256:transcript-email',
    });
    const noTranscriptEmails = await request(baseUrl, '/calls/sip/transcript-emails/pending');
    expect(noTranscriptEmails.body.emails).toHaveLength(0);
    const archivePending = await request(baseUrl, '/calls/sip/knowledge-archive/pending');
    expect(archivePending.body.archives).toHaveLength(1);
    expect(archivePending.body.archives[0]).toMatchObject({ missionId, status: 'pending', room: 'incoming_calls' });
    const archiveFailed = await request(baseUrl, `/calls/sip/knowledge-archive/${missionId}/failed`, {
      method: 'POST', body: JSON.stringify({ errorType: 'MempalaceUnavailable' }),
    });
    expect(archiveFailed.status).toBe(200);
    const archiveRetry = await request(baseUrl, '/calls/sip/knowledge-archive/pending');
    expect(archiveRetry.body.archives).toHaveLength(0);
    const failedArchiveStatus = await request(baseUrl, `/calls/sip/knowledge-archive/${missionId}/status`);
    expect(failedArchiveStatus.body.delivery).toMatchObject({ missionId, status: 'failed', attempts: 1 });
    expect(failedArchiveStatus.body.delivery.nextAttemptAt).toBeTruthy();
    db.prepare("UPDATE sip_knowledge_archive_delivery SET next_attempt_at = datetime('now', '-1 second') WHERE mission_id = ?")
      .run(missionId);
    const archiveRetryDue = await request(baseUrl, '/calls/sip/knowledge-archive/pending');
    expect(archiveRetryDue.body.archives[0]).toMatchObject({ missionId, status: 'failed', attempts: 1 });
    const contentSha256 = createHash('sha256').update('test transcript document', 'utf8').digest('hex');
    const archiveDelivered = await request(baseUrl, `/calls/sip/knowledge-archive/${missionId}/delivered`, {
      method: 'POST',
      body: JSON.stringify({ drawerId: 'sip_incoming_test', contentSha256, room: 'incoming_calls' }),
    });
    expect(archiveDelivered.status).toBe(200);
    const archiveStatus = await request(baseUrl, `/calls/sip/knowledge-archive/${missionId}/status`);
    expect(archiveStatus.body.delivery).toMatchObject({
      missionId,
      status: 'delivered',
      attempts: 2,
      room: 'incoming_calls',
      drawerId: 'sip_incoming_test',
      contentSha256,
    });
    const noArchivePending = await request(baseUrl, '/calls/sip/knowledge-archive/pending');
    expect(noArchivePending.body.archives).toHaveLength(0);
    const draft = db.prepare('SELECT subject, text_body FROM drafts WHERE id = ?')
      .get(finalized.body.recapDraftId) as { subject: string; text_body: string };
    expect(draft.subject).toContain(missionId);
    expect(draft.text_body).toContain('full turn-by-turn transcript is stored');
    const pending = await request(baseUrl, '/calls/sip/recap-drafts/pending');
    expect(pending.body.drafts).toHaveLength(1);
    expect(pending.body.drafts[0].missionId).toBe(missionId);
    const pendingStatus = await request(baseUrl, `/calls/sip/recap-drafts/${missionId}/status`);
    expect(pendingStatus.body.delivery).toMatchObject({ missionId, status: 'pending', attempts: 0 });
    const delivered = await request(baseUrl, `/calls/sip/recap-drafts/${missionId}/delivered`, {
      method: 'POST', body: JSON.stringify({ exchangeRefHash: 'sha256:test-ref' }),
    });
    expect(delivered.status).toBe(200);
    const deliveredStatus = await request(baseUrl, `/calls/sip/recap-drafts/${missionId}/status`);
    expect(deliveredStatus.body.delivery).toMatchObject({
      missionId,
      status: 'delivered',
      attempts: 1,
      exchangeRefHash: 'sha256:test-ref',
    });
    const nonePending = await request(baseUrl, '/calls/sip/recap-drafts/pending');
    expect(nonePending.body.drafts).toHaveLength(0);
    db.close();
  }, 15_000);

  it('configures phone transport without leaking secrets', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));

    const setup = await setupTransport(baseUrl);
    expect(setup.status).toBe(200);
    expect(setup.body.transport).toMatchObject({
      provider: '46elks',
      phoneNumber: '+43123456789',
      password: '***',
      webhookSecret: '***',
    });

    const capabilities = await request(baseUrl, '/phone/capabilities');
    expect(capabilities.body).toMatchObject({
      provider: '46elks',
      capabilities: ['call_control'],
      supportedRegions: ['AT', 'DE'],
      realtimeReady: false,
    });

    db.close();
  });

  it('rejects a transport setup with a weak webhook secret', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));

    const setup = await request(baseUrl, '/phone/transport/setup', {
      method: 'POST',
      body: JSON.stringify({
        provider: '46elks',
        phoneNumber: '+43123456789',
        username: 'user',
        password: 'api-password-secret',
        webhookBaseUrl: 'https://agenticmail.example.com',
        webhookSecret: 'short',
        supportedRegions: ['AT', 'DE'],
      }),
    });
    expect(setup.status).toBe(400);
    expect(String(setup.body.error)).toMatch(/at least 24 characters/);

    db.close();
  });

  it('starts a dry-run mission and exposes status/transcript/cancel endpoints', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));
    await setupTransport(baseUrl);

    const started = await request(baseUrl, '/calls/start', {
      method: 'POST',
      body: JSON.stringify({
        to: '+436641234567',
        task: 'Reserve dinner',
        policy,
        dryRun: true,
      }),
    });
    expect(started.status).toBe(200);
    expect(started.body.mission.status).toBe('dialing');
    expect(started.body.providerRequest.body.voice_start).toBe('[redacted-url]');

    const missionId = started.body.mission.id;
    const loaded = await request(baseUrl, `/calls/${missionId}`);
    expect(loaded.body.mission.id).toBe(missionId);

    const transcript = await request(baseUrl, `/calls/${missionId}/transcript`);
    expect(transcript.body.transcript.length).toBeGreaterThan(0);

    const cancelled = await request(baseUrl, `/calls/${missionId}/cancel`, { method: 'POST' });
    expect(cancelled.body.mission.status).toBe('cancelled');

    db.close();
  });

  it('authenticates 46elks voice-start and hangup webhooks', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));
    await setupTransport(baseUrl);
    const started = await request(baseUrl, '/calls/start', {
      method: 'POST',
      body: JSON.stringify({ to: '+436641234567', task: 'Reserve dinner', policy, dryRun: true }),
    });
    const missionId = started.body.mission.id;
    const token = tokenFor(missionId);

    // Forged token -> uniform 403.
    const forged = await request(baseUrl, `/calls/webhook/46elks/voice-start?missionId=${missionId}&token=wrong`, {
      method: 'POST',
      body: JSON.stringify({ callid: 'call123' }),
    });
    expect(forged.status).toBe(403);

    // An unknown mission must return the SAME 403 + body — no 404-vs-403
    // enumeration oracle (#43-H3).
    const unknown = await request(baseUrl, `/calls/webhook/46elks/voice-start?missionId=call_does-not-exist&token=${token}`, {
      method: 'POST',
      body: JSON.stringify({ callid: 'call123' }),
    });
    expect(unknown.status).toBe(403);
    expect(unknown.body).toEqual(forged.body);

    const voiceStart = await request(baseUrl, `/calls/webhook/46elks/voice-start?missionId=${missionId}&token=${token}`, {
      method: 'POST',
      body: JSON.stringify({ callid: 'call123' }),
    });
    expect(voiceStart.status).toBe(200);
    expect(voiceStart.body.play).toContain('AgenticMail');

    const hangup = await request(baseUrl, `/calls/webhook/46elks/hangup?missionId=${missionId}&token=${token}`, {
      method: 'POST',
      body: JSON.stringify({ callid: 'call123' }),
    });
    expect(hangup.body.mission.status).toBe('failed');

    db.close();
  });

  it('lists and answers operator queries (ask_operator endpoints)', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));
    await setupTransport(baseUrl);
    const started = await request(baseUrl, '/calls/start', {
      method: 'POST',
      body: JSON.stringify({ to: '+436641234567', task: 'Reserve dinner', policy, dryRun: true }),
    });
    const missionId = started.body.mission.id;

    // The bridge records the query at runtime; seed one against the same DB.
    const manager = new PhoneManager(db as any, config.masterKey);
    const { query } = manager.addOperatorQuery(missionId, { question: 'Is 8pm acceptable?' });

    const list = await request(baseUrl, `/calls/${missionId}/operator-queries`);
    expect(list.status).toBe(200);
    expect(list.body.operatorQueries).toHaveLength(1);
    expect(list.body.operatorQueries[0].question).toBe('Is 8pm acceptable?');
    expect(list.body.callbackPending).toBe(false);

    const answer = await request(baseUrl, `/calls/${missionId}/operator-queries/${query.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: 'Yes, 8pm is fine' }),
    });
    expect(answer.status).toBe(200);
    expect(answer.body.alreadyAnswered).toBe(false);
    expect(answer.body.query.answer).toBe('Yes, 8pm is fine');
    expect(answer.body.callback.triggered).toBe(false); // not callback-pending

    // The list now reflects the answer.
    const list2 = await request(baseUrl, `/calls/${missionId}/operator-queries`);
    expect(list2.body.operatorQueries[0].answer).toBe('Yes, 8pm is fine');

    // An empty answer is rejected.
    const empty = await request(baseUrl, `/calls/${missionId}/operator-queries/${query.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: '' }),
    });
    expect(empty.status).toBe(400);

    // An unknown query id returns 404.
    const missing = await request(baseUrl, `/calls/${missionId}/operator-queries/oq_nope/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: 'whatever' }),
    });
    expect(missing.status).toBe(404);

    db.close();
  });

  it('answering a callback-pending query triggers a callback dial (plan §7)', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));
    await setupTransport(baseUrl);
    const started = await request(baseUrl, '/calls/start', {
      method: 'POST',
      body: JSON.stringify({ to: '+436641234567', task: 'Reserve dinner', policy, dryRun: true }),
    });
    const missionId = started.body.mission.id;

    const manager = new PhoneManager(db as any, config.masterKey);
    const { query } = manager.addOperatorQuery(missionId, { question: 'Confirm the booking?' });
    manager.flagCallbackPending(missionId); // the call dropped while unanswered

    // The callback dials 46elks; the test client itself uses fetch, so the
    // stub routes 46elks calls to a fake and passes everything else through.
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url: any, init: any) => (
      String(url).includes('46elks.com')
        ? new Response(JSON.stringify({ id: 'callback-call' }), { status: 200 })
        : realFetch(url, init)
    ));
    vi.stubGlobal('fetch', fetchMock);

    const answer = await request(baseUrl, `/calls/${missionId}/operator-queries/${query.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: 'Yes, go ahead and confirm it' }),
    });
    vi.unstubAllGlobals();

    expect(answer.status).toBe(200);
    expect(answer.body.callback.triggered).toBe(true);
    expect(answer.body.callback.missionId).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('46elks.com'))).toBe(true);

    db.close();
  });
});
