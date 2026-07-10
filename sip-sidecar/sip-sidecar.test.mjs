import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EncryptedTranscriptSpool,
  OpenAiRealtimeBridge,
  RtpSession,
  SipCall,
  SipSidecar,
  buildSipMessage,
  businessHoursStatus,
  parseSipMessage,
  sipDialableUser,
} from './sip-sidecar.mjs';

function inviteMessage(callId = 'inbound-test@example.invalid') {
  const sdp = [
    'v=0',
    'o=test 1 1 IN IP4 192.0.2.20',
    's=test',
    'c=IN IP4 192.0.2.20',
    't=0 0',
    'm=audio 41000 RTP/AVP 0',
    'a=rtpmap:0 PCMU/8000',
    '',
  ].join('\r\n');
  return buildSipMessage('INVITE sip:1000@pbx.test SIP/2.0', [
    ['Via', 'SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-test'],
    ['From', '<sip:114@pbx.test>;tag=caller-tag'],
    ['To', '<sip:1000@pbx.test>'],
    ['Call-ID', callId],
    ['CSeq', '1 INVITE'],
    ['Contact', '<sip:114@192.0.2.10:5060>'],
    ['Content-Type', 'application/sdp'],
  ], sdp);
}

function inDialogRequest(method, callId, cseq) {
  return buildSipMessage(`${method} sip:1000@pbx.test SIP/2.0`, [
    ['Via', `SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-${method.toLowerCase()}`],
    ['From', '<sip:114@pbx.test>;tag=caller-tag'],
    ['To', '<sip:1000@pbx.test>;tag=agent-tag'],
    ['Call-ID', callId],
    ['CSeq', `${cseq} ${method}`],
  ]);
}

test('extracts only dialable caller identities from SIP URIs', () => {
  assert.equal(sipDialableUser('<sip:+12025550123@pbx.test>;tag=caller'), '+12025550123');
  assert.equal(sipDialableUser('sip:114@pbx.test'), '114');
  assert.equal(sipDialableUser('sip:not-a-number@pbx.test'), '');
});

test('retransmitted inbound INVITE creates one call and one Realtime greeting', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenticmail-sip-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'pbx.json');
  const agenticmailConfigPath = join(dir, 'agenticmail.json');
  writeFileSync(configPath, JSON.stringify({
    server: '127.0.0.1',
    username: '1000',
    localIp: '127.0.0.1',
    liveAnswerEnabled: true,
    transcriptPersistenceRequired: false,
    auditPath: join(dir, 'events.jsonl'),
  }));
  writeFileSync(agenticmailConfigPath, JSON.stringify({ openaiApiKey: 'test-key' }));

  const sidecar = new SipSidecar({ configPath, agenticmailConfigPath });
  t.after(() => {
    try { sidecar.socket.close(); } catch { /* socket was never bound */ }
  });
  sidecar.missing = () => [];
  const sent = [];
  sidecar.send = (text) => sent.push(parseSipMessage(text));

  let releaseRealtime;
  let bridgeCount = 0;
  let greetingCount = 0;
  let rtpClosed = false;
  sidecar.createRtpSession = () => ({
    start: async () => {},
    setRemote: () => {},
    sendAudio: () => {},
    stats: () => ({ inboundPackets: 0, outboundPackets: 0 }),
    close: () => { rtpClosed = true; },
  });
  sidecar.createOpenAiBridge = () => {
    bridgeCount += 1;
    return {
      connect: () => new Promise((resolve) => { releaseRealtime = resolve; }),
      startResponse: () => { greetingCount += 1; return true; },
      close: () => {},
    };
  };

  const callId = 'one-call@example.invalid';
  const invite = parseSipMessage(inviteMessage(callId));
  const first = sidecar.handleInvite(invite, { address: '192.0.2.10', port: 5060 });
  while (!releaseRealtime) await new Promise((resolve) => setImmediate(resolve));

  await sidecar.handleInvite(invite, { address: '192.0.2.10', port: 5060 });
  assert.equal(sidecar.calls.size, 1);
  assert.equal(bridgeCount, 1);
  assert.equal(sent.at(-1).startLine, 'SIP/2.0 180 Ringing');

  releaseRealtime();
  const call = await first;
  assert.equal(call.status, 'media_ready');
  assert.equal(sent.at(-1).startLine, 'SIP/2.0 200 OK');

  await sidecar.handleInvite(invite, { address: '192.0.2.10', port: 5060 });
  assert.equal(sidecar.calls.size, 1);
  assert.equal(sent.at(-1).startLine, 'SIP/2.0 200 OK');

  await sidecar.handleSip(Buffer.from(inDialogRequest('ACK', callId, 1)), { address: '192.0.2.10', port: 5060 });
  await sidecar.handleSip(Buffer.from(inDialogRequest('ACK', callId, 1)), { address: '192.0.2.10', port: 5060 });
  assert.equal(call.status, 'media_active');
  assert.equal(greetingCount, 1);

  await sidecar.handleSip(Buffer.from(inDialogRequest('BYE', callId, 2)), { address: '192.0.2.10', port: 5060 });
  assert.equal(call.status, 'ended');
  assert.equal(sidecar.callsBySipId.has(callId), false);
  assert.equal(rtpClosed, true);
});

test('outbound PCMU is paced as one 20 ms RTP packet per flush', () => {
  const packets = [];
  const rtp = new RtpSession({
    localIp: '127.0.0.1',
    port: 40200,
    remoteIp: '192.0.2.20',
    remotePort: 41000,
  });
  rtp.socket.send = (packet) => packets.push(packet);

  rtp.sendAudio(Buffer.alloc(400, 0x7f));
  assert.equal(packets.length, 0);
  rtp.flushOutboundAudio();
  assert.equal(packets.length, 1);
  assert.equal(packets[0].length, 172);
  rtp.flushOutboundAudio();
  assert.equal(packets.length, 2);
  assert.equal(rtp.stats().outboundQueuedBytes, 80);

  rtp.close();
});

test('outbound PCMU buffers a ten second response without dropping audio', () => {
  const rtp = new RtpSession({
    localIp: '127.0.0.1',
    port: 40201,
    remoteIp: '192.0.2.20',
    remotePort: 41000,
  });

  rtp.sendAudio(Buffer.alloc(80000, 0x7f));
  assert.equal(rtp.stats().outboundQueuedBytes, 80000);
  assert.equal(rtp.stats().outboundOverflowDroppedBytes, 0);

  rtp.close();
  assert.equal(rtp.stats().outboundAbandonedBytes, 80000);
});

test('outbound PCMU preserves queued audio when the safety buffer overflows', () => {
  const packets = [];
  const rtp = new RtpSession({
    localIp: '127.0.0.1',
    port: 40202,
    remoteIp: '192.0.2.20',
    remotePort: 41000,
  });
  rtp.socket.send = (packet) => packets.push(packet);

  const audio = Buffer.concat([
    Buffer.alloc(160, 0x11),
    Buffer.alloc(479840, 0x22),
    Buffer.alloc(20000, 0x33),
  ]);
  rtp.sendAudio(audio);
  assert.equal(rtp.stats().outboundQueuedBytes, 480000);
  assert.equal(rtp.stats().outboundOverflowDroppedBytes, 20000);

  rtp.flushOutboundAudio();
  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0].subarray(12), Buffer.alloc(160, 0x11));

  rtp.clearOutboundAudio();
  assert.equal(rtp.stats().outboundInterruptedBytes, 479840);
  assert.equal(rtp.stats().outboundDroppedBytes, 499840);
  rtp.close();
});

test('CANCEL during Realtime setup terminates the one pending inbound call', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenticmail-sip-cancel-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'pbx.json');
  const agenticmailConfigPath = join(dir, 'agenticmail.json');
  writeFileSync(configPath, JSON.stringify({
    server: '127.0.0.1',
    username: '1000',
    localIp: '127.0.0.1',
    liveAnswerEnabled: true,
    transcriptPersistenceRequired: false,
    auditPath: join(dir, 'events.jsonl'),
  }));
  writeFileSync(agenticmailConfigPath, JSON.stringify({ openaiApiKey: 'test-key' }));

  const sidecar = new SipSidecar({ configPath, agenticmailConfigPath });
  t.after(() => {
    try { sidecar.socket.close(); } catch { /* socket was never bound */ }
  });
  sidecar.missing = () => [];
  const sent = [];
  sidecar.send = (text) => sent.push(parseSipMessage(text));
  sidecar.createRtpSession = () => ({
    start: async () => {}, setRemote: () => {}, sendAudio: () => {}, stats: () => ({}), close: () => {},
  });

  let rejectRealtime;
  sidecar.createOpenAiBridge = () => ({
    connect: () => new Promise((_resolve, reject) => { rejectRealtime = reject; }),
    startResponse: () => true,
    close: () => rejectRealtime?.(new Error('closed by CANCEL')),
  });

  const callId = 'cancel-call@example.invalid';
  const pending = sidecar.handleInvite(parseSipMessage(inviteMessage(callId)), { address: '192.0.2.10', port: 5060 });
  while (!rejectRealtime) await new Promise((resolve) => setImmediate(resolve));
  await sidecar.handleSip(Buffer.from(inDialogRequest('CANCEL', callId, 1)), { address: '192.0.2.10', port: 5060 });
  const call = await pending;

  assert.equal(call.status, 'ended');
  assert.equal(sidecar.callsBySipId.has(callId), false);
  assert.equal(sent.filter((msg) => msg.startLine === 'SIP/2.0 487 Request Terminated').length, 1);
  assert.equal(sent.filter((msg) => msg.startLine === 'SIP/2.0 200 OK').length, 1);
});

test('final caller and agent transcript text is persisted in sequence', () => {
  const persisted = [];
  const finalized = [];
  const sidecar = {
    transcriptPersistenceRequired: true,
    missionClient: {
      appendTranscript: (missionId, entry) => persisted.push({ missionId, entry }),
      finalize: (missionId, body) => finalized.push({ missionId, body }),
    },
    logEvent: () => {},
    onCallEnded: () => {},
    sendBye: () => {},
  };
  const call = new SipCall({ id: 'sip-test', direction: 'inbound', sidecar });
  call.missionId = 'call-test';
  call.recordTranscriptEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    text: 'Нужен расчет перевозки.',
  });
  call.recordTranscriptEvent({
    type: 'response.output_audio_transcript.done',
    text: 'Уточните, пожалуйста, маршрут.',
  });
  call.end('remote_bye');

  assert.deepEqual(persisted.map((item) => item.entry.source), ['provider', 'agent']);
  assert.deepEqual(persisted.map((item) => item.entry.text), [
    'Нужен расчет перевозки.',
    'Уточните, пожалуйста, маршрут.',
  ]);
  assert.deepEqual(persisted.map((item) => item.entry.metadata.sequence), [1, 2]);
  assert.equal(finalized[0].body.status, 'completed');
  assert.equal(finalized[0].body.metadata.transcriptTurnCount, 2);
});

test('sales intake tools persist structured facts and callback requests without dialing', async () => {
  const updates = [];
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.logEvent = () => {};
  sidecar.buildInstructions = () => 'specialist instructions';
  sidecar.missionClient = {
    updateIntake: async (_missionId, patch) => {
      updates.push(patch);
      return { success: true, complete: false, intake: { missingFields: ['destination'] } };
    },
    lookupKnowledge: async () => ({
      count: 1,
      facts: [{ title: 'Verified policy', content: 'Manager review is required.' }],
    }),
  };
  const instructionUpdates = [];
  const call = {
    id: 'sip-tool-test', missionId: 'call-tool-test', end: () => {},
    openai: { updateInstructions: (value) => instructionUpdates.push(value) },
  };

  const routed = await sidecar.executeCallTool(call, 'route_call_specialist', {
    relationship: 'new_customer', requestType: 'freight', serviceTopic: 'ocean_freight', reason: 'Needs a freight quote',
  });
  const intake = await sidecar.executeCallTool(call, 'update_call_intake', {
    relationship: 'new_customer', requestType: 'freight', origin: 'Shanghai',
  });
  const callback = await sidecar.executeCallTool(call, 'request_callback', {
    reason: 'Manager should confirm the routing', dueAt: '2026-07-11T09:00:00Z',
  });
  const knowledge = await sidecar.executeCallTool(call, 'lookup_verified_information', {
    query: 'quotation policy',
  });

  assert.equal(routed.ok, true);
  assert.equal(routed.specialistProfile, 'new_customer');
  assert.equal(routed.specialistTopic, 'ocean_freight');
  assert.equal(updates[0].serviceTopic, 'ocean_freight');
  assert.deepEqual(instructionUpdates, ['specialist instructions']);
  assert.equal(intake.ok, true);
  assert.deepEqual(intake.missingFields, ['destination']);
  assert.equal(callback.callbackIsRequestOnly, true);
  assert.equal(updates[2].nextAction.type, 'callback_request');
  assert.equal(updates[2].outcome, 'needs_follow_up');
  assert.equal(knowledge.count, 1);
});

test('sales instructions expose only the active service playbook after routing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenticmail-sip-prompt-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'pbx.json');
  const agenticmailConfigPath = join(dir, 'agenticmail.json');
  writeFileSync(configPath, JSON.stringify({
    server: '127.0.0.1',
    username: '1000',
    localIp: '127.0.0.1',
    salesScenarioPath: join(process.cwd(), 'sip-sidecar', 'sales-call-scenario.json'),
  }));
  writeFileSync(agenticmailConfigPath, JSON.stringify({}));

  const sidecar = new SipSidecar({ configPath, agenticmailConfigPath });
  t.after(() => {
    try { sidecar.socket.close(); } catch { /* socket was never bound */ }
  });

  const routingPrompt = sidecar.buildInstructions({ direction: 'inbound', loadedSkills: [] });
  assert.match(routingPrompt, /# Routing/);
  assert.doesNotMatch(routingPrompt, /# Active Service Playbook/);
  assert.doesNotMatch(routingPrompt, /сумму в рублях/);

  const paymentPrompt = sidecar.buildInstructions({
    direction: 'inbound',
    loadedSkills: [],
    specialistRoute: { relationship: 'new_customer', requestType: 'service', serviceTopic: 'payment_agent' },
  });
  assert.match(paymentPrompt, /Service topic: payment_agent/);
  assert.match(paymentPrompt, /сумму в рублях/);
  assert.doesNotMatch(paymentPrompt, /POL\/POD/);
});

test('direct SIP tools can search and load an installed conversation skill', async () => {
  const events = [];
  const instructionUpdates = [];
  const systemTranscript = [];
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.logEvent = (type, payload) => events.push({ type, payload });
  sidecar.missionClient = null;
  sidecar.buildInstructions = (call) => call.loadedSkills.map((skill) => skill.renderedPrompt).join('\n');
  const call = {
    id: 'sip-skill-test',
    missionId: null,
    loadedSkills: [],
    openai: { updateInstructions: (value) => { instructionUpdates.push(value); return true; } },
    recordSystemTranscript: (text, metadata) => systemTranscript.push({ text, metadata }),
  };

  const search = await sidecar.executeCallTool(call, 'search_skills', {
    query: 'BANT sales discovery budget authority need timing',
  });
  assert.equal(search.ok, true);
  assert.equal(search.skills.some((skill) => skill.id === 'bant-discovery-call'), true);

  const loaded = await sidecar.executeCallTool(call, 'load_skill', { id: 'bant-discovery-call' });
  assert.equal(loaded.ok, true);
  assert.equal(call.loadedSkills[0].id, 'bant-discovery-call');
  assert.equal(instructionUpdates[0].includes('SKILL LOADED'), true);
  assert.equal(systemTranscript.at(-1).text.includes('bant-discovery-call'), true);
  assert.equal(events.some((event) => event.type === 'call_tool_completed'), true);
});

test('NBR SPIN and MEDDPICC local playbooks are valid and scope complex qualification', async () => {
  const { validateSkill } = await import('@agenticmail/core');
  const spin = JSON.parse(readFileSync(
    join(process.cwd(), 'sip-sidecar', 'local-skills', 'nbr-spin-discovery.json'),
    'utf8',
  ));
  const meddpicc = JSON.parse(readFileSync(
    join(process.cwd(), 'sip-sidecar', 'local-skills', 'nbr-meddpicc-complex-b2b.json'),
    'utf8',
  ));

  assert.deepEqual(validateSkill(spin), []);
  assert.deepEqual(validateSkill(meddpicc), []);
  assert.match(spin.context.when_to_use, /основной методикой/u);
  assert.match(meddpicc.context.when_to_use, /Не использовать для простого запроса ставки/u);
});

test('configured company context is required and included in direct SIP instructions', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenticmail-company-context-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'pbx.json');
  const agenticmailConfigPath = join(dir, 'agenticmail.json');
  const contextPath = join(dir, 'company-context.md');
  writeFileSync(contextPath, '# Approved company context\n\nVerified service fact.');
  writeFileSync(configPath, JSON.stringify({
    server: '127.0.0.1',
    username: '1000',
    localIp: '127.0.0.1',
    transcriptPersistenceRequired: false,
    companyContextPath: contextPath,
    companyContextRequired: true,
  }));
  writeFileSync(agenticmailConfigPath, JSON.stringify({ openaiApiKey: 'test-key' }));

  const sidecar = new SipSidecar({ configPath, agenticmailConfigPath });
  t.after(() => {
    try { sidecar.socket.close(); } catch { /* socket was never bound */ }
  });
  assert.equal(sidecar.companyContext.includes('Verified service fact.'), true);
  assert.equal(sidecar.missing({ refresh: false }).includes('company_context_missing'), false);
  const instructions = sidecar.buildInstructions({
    direction: 'inbound', task: '', specialistRoute: null, loadedSkills: [],
  });
  assert.equal(instructions.includes('# Approved company runtime context'), true);
  assert.equal(instructions.includes('Verified service fact.'), true);
});

test('transcript fallback spool is encrypted and can be replayed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenticmail-sip-spool-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'transcript-spool.enc.jsonl');
  const spool = new EncryptedTranscriptSpool(path, 'test-master-key');
  const operation = {
    kind: 'transcript',
    missionId: 'call-test',
    entries: [{ source: 'provider', text: 'sensitive transcript text' }],
  };

  spool.append(operation);
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.includes('sensitive transcript text'), false);
  assert.equal(spool.count(), 1);

  const delivered = [];
  const result = await spool.flush(async (item) => delivered.push(item));
  assert.deepEqual(result, { delivered: 1, remaining: 0 });
  assert.deepEqual(delivered, [operation]);
  assert.equal(spool.count(), 0);
});

test('business hours support normal and overnight schedules', () => {
  const config = {
    enabled: true,
    timezone: 'UTC',
    schedule: {
      monday: ['09:00-18:00'],
      friday: ['22:00-02:00'],
    },
  };
  assert.equal(businessHoursStatus(config, new Date('2026-07-06T10:00:00Z')).open, true);
  assert.equal(businessHoursStatus(config, new Date('2026-07-06T20:00:00Z')).open, false);
  assert.equal(businessHoursStatus(config, new Date('2026-07-11T01:00:00Z')).open, true);
  assert.equal(businessHoursStatus(null, new Date()).open, true);
});

test('Realtime bridge flushes unfinished transcript deltas on close', () => {
  const events = [];
  const bridge = new OpenAiRealtimeBridge({
    apiKey: 'test', model: 'gpt-realtime-2.1', voice: 'marin', instructions: 'test',
    onEvent: (event) => events.push(event),
  });
  bridge.handleMessage(JSON.stringify({
    type: 'response.output_audio_transcript.delta', item_id: 'item-1', delta: 'Partial answer',
  }));
  bridge.close();
  assert.equal(events.length, 1);
  assert.equal(events[0].text, 'Partial answer');
  assert.equal(events[0].partial, true);
});

test('Realtime bridge emits conversation truncation for interrupted playback', () => {
  const sent = [];
  const bridge = new OpenAiRealtimeBridge({
    apiKey: 'test', model: 'gpt-realtime-2.1', voice: 'marin', instructions: 'test',
  });
  bridge.ws = { readyState: 1, send: (value) => sent.push(JSON.parse(value)) };
  assert.equal(bridge.truncateAudio('item-1', 0, 1250), true);
  assert.deepEqual(sent[0], {
    type: 'conversation.item.truncate',
    item_id: 'item-1',
    content_index: 0,
    audio_end_ms: 1250,
  });
  assert.equal(bridge.updateInstructions('specialist instructions'), true);
  assert.deepEqual(sent[1], {
    type: 'session.update',
    session: { type: 'realtime', instructions: 'specialist instructions' },
  });
});

test('Realtime wait tool ends the turn without creating spoken output', async () => {
  const sent = [];
  const bridge = new OpenAiRealtimeBridge({
    apiKey: 'test', model: 'gpt-realtime-2.1', voice: 'marin', instructions: 'test',
    onToolCall: async () => ({ ok: true, waiting: true, suppressResponse: true }),
  });
  bridge.ws = { readyState: 1, send: (value) => sent.push(JSON.parse(value)) };

  await bridge.dispatchToolCall({ call_id: 'wait-1', name: 'wait_for_user', arguments: '{}' });

  assert.equal(sent.some((event) => event.type === 'conversation.item.create'), true);
  assert.equal(sent.some((event) => event.type === 'response.create'), false);
});
