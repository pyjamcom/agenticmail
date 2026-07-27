import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import {
  AgenticMailSipMissionClient,
  EncryptedTranscriptSpool,
  OpenAiRealtimeBridge,
  RtpSession,
  SipCall,
  SipSidecar,
  allowedTnvedCodePrefixesForProduct,
  buildSipMessage,
  businessHoursStatus,
  detectCustomsIntent,
  parseSipMessage,
  playbackTruncationMs,
  sipDialableUser,
} from './sip-sidecar.mjs';

function testNbrServiceRates() {
  const raw = JSON.parse(readFileSync(new URL('./nbr-service-rates.json', import.meta.url), 'utf8'));
  const ratesByCode = Object.fromEntries(
    raw.rates.map((rate) => [
      rate.code,
      {
        code: rate.code,
        service: rate.service,
        unit: rate.unit,
        currency: rate.currency,
        maxRateRub: rate.maxRateRub,
      },
    ]),
  );
  return {
    ok: true,
    version: raw.version,
    sourceHash: createHash('sha256').update(JSON.stringify(ratesByCode), 'utf8').digest('hex'),
    ratesByCode,
    missingCodes: [],
    rateSemantics: raw.rateSemantics,
    spokenBoundary: raw.spokenBoundary,
  };
}

test('early customs intent detector routes first mentions without applying M1 broadly', () => {
  for (const phrase of [
    'автомобиль',
    'растаможка',
    'таможня',
    'таможенное оформление',
    'нужно растаможить груз',
    'импорт товара',
    'экспорт товара',
    'таможенная декларация',
    'декларация таможенная',
    'код ТН ВЭД',
    'ввозная пошлина',
    'НДС при ввозе',
    'утилизационный сбор',
  ]) {
    assert.equal(detectCustomsIntent(phrase).matched, true, phrase);
  }
  assert.deepEqual(
    detectCustomsIntent('Хочу растаможить автомобиль'),
    {
      matched: true,
      explicitRequest: false,
      transferRequested: false,
      direction: 'import_to_russia',
      vehicleKind: 'unknown_vehicle',
      recommendedFlow: 'clarify_vehicle_type',
    },
  );
  assert.equal(
    detectCustomsIntent('Рассчитайте таможенные платежи на легковой автомобиль M1').recommendedFlow,
    'vehicle_m1',
  );
  const truck = detectCustomsIntent('Сколько будет растаможка грузовика N3?');
  assert.equal(truck.explicitRequest, true);
  assert.equal(truck.vehicleKind, 'commercial');
  assert.equal(truck.recommendedFlow, 'tnved_vehicle');
  assert.equal(
    detectCustomsIntent('Нужен код ТН ВЭД и декларация на товар').recommendedFlow,
    'tnved_goods_or_clarify',
  );
  const exportIntent = detectCustomsIntent('Планируем экспорт товара из России');
  assert.equal(exportIntent.matched, true);
  assert.equal(exportIntent.direction, 'export_from_russia');
  assert.equal(
    detectCustomsIntent('Переведите в таможенный отдел').transferRequested,
    true,
  );
  assert.equal(detectCustomsIntent('Отправьте, пожалуйста, отчет по электронной почте').matched, false);
});

test('deterministic customs router updates the live call instructions on the caller turn', () => {
  const instructionUpdates = [];
  const audit = [];
  const systemTranscript = [];
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.buildInstructions = (call) => `flow=${call.customsRouting.recommendedFlow}`;
  sidecar.logEvent = (type, payload) => audit.push({ type, payload });
  const call = {
    id: 'customs-router-call',
    customsRouting: {
      matched: false,
      recommendedFlow: 'none',
      offerMade: false,
      started: false,
    },
    openai: { updateInstructions: (instructions) => instructionUpdates.push(instructions) },
    recordSystemTranscript: (text, metadata) => systemTranscript.push({ text, metadata }),
  };
  const intent = sidecar.observeCustomsRouting(call, {
    type: 'conversation.item.input_audio_transcription.completed',
    text: 'Рассчитайте растаможку мотоцикла',
  });
  assert.equal(intent.recommendedFlow, 'tnved_vehicle');
  assert.equal(call.customsRouting.explicitRequest, true);
  assert.deepEqual(instructionUpdates, ['flow=tnved_vehicle']);
  assert.equal(audit[0].type, 'call_customs_intent_detected');
  assert.equal(systemTranscript[0].metadata.vehicleKind, 'motorcycle');
});

test('vehicle TNVED chapter gate defines only relevant headings', () => {
  assert.deepEqual(
    allowedTnvedCodePrefixesForProduct('седельный тягач Volvo FH категории N3'),
    ['8701'],
  );
  assert.deepEqual(
    allowedTnvedCodePrefixesForProduct('грузовой автомобиль категории N2'),
    ['8704'],
  );
  assert.deepEqual(allowedTnvedCodePrefixesForProduct('автобус M3'), ['8702']);
  assert.deepEqual(allowedTnvedCodePrefixesForProduct('мотоцикл'), ['8711']);
  assert.deepEqual(allowedTnvedCodePrefixesForProduct('полуприцеп'), ['8716']);
  assert.deepEqual(
    allowedTnvedCodePrefixesForProduct('гусеничный экскаватор'),
    ['8427', '8429', '8430', '8701', '8705'],
  );
  assert.deepEqual(allowedTnvedCodePrefixesForProduct('самоклеящаяся пленка'), []);
});

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

function inDialogRequest(method, callId, cseq, extraHeaders = []) {
  return buildSipMessage(`${method} sip:1000@pbx.test SIP/2.0`, [
    ['Via', `SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-${method.toLowerCase()}`],
    ['From', '<sip:114@pbx.test>;tag=caller-tag'],
    ['To', '<sip:1000@pbx.test>;tag=agent-tag'],
    ['Call-ID', callId],
    ['CSeq', `${cseq} ${method}`],
    ...extraHeaders,
  ]);
}

test('extracts only dialable caller identities from SIP URIs', () => {
  assert.equal(sipDialableUser('<sip:+12025550123@pbx.test>;tag=caller'), '+12025550123');
  assert.equal(sipDialableUser('sip:114@pbx.test'), '114');
  assert.equal(sipDialableUser('sip:not-a-number@pbx.test'), '');
});

test('loads UTF-8 JSON configuration files with a BOM', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenticmail-sip-bom-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'pbx.json');
  const agenticmailConfigPath = join(dir, 'agenticmail.json');
  writeFileSync(configPath, `\uFEFF${JSON.stringify({
    server: '127.0.0.1',
    username: '1000',
    localIp: '127.0.0.1',
    transcriptPersistenceRequired: false,
  })}`);
  writeFileSync(agenticmailConfigPath, `\uFEFF${JSON.stringify({ openaiApiKey: 'test-key' })}`);

  const sidecar = new SipSidecar({ configPath, agenticmailConfigPath });
  t.after(() => {
    try { sidecar.socket.close(); } catch { /* socket was never bound */ }
  });
  assert.equal(sidecar.username, '1000');
  assert.equal(sidecar.openaiKey, 'test-key');
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
  assert.equal(call.status, 'media_active');
  assert.equal(greetingCount, 1);
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

test('missing ACK does not end an inbound call with confirmed RTP media', () => {
  const events = [];
  const call = Object.create(SipCall.prototype);
  Object.assign(call, {
    id: 'sip-no-ack-with-rtp',
    status: 'media_active',
    acknowledged: false,
    mediaConfirmedByRtp: true,
    ackTimer: {},
    rtp: { stats: () => ({ inboundPackets: 42 }) },
    sidecar: { logEvent: (type, details) => events.push({ type, details }) },
    end: () => { throw new Error('call must not end while RTP is active'); },
  });

  call.handleAckTimeout();

  assert.equal(call.status, 'media_active');
  assert.equal(call.ackTimer, null);
  assert.equal(events[0].type, 'inbound_ack_missing_media_confirmed');
  assert.equal(events[0].details.inboundPackets, 42);
});

test('missing ACK still ends an inbound call when no RTP media arrives', () => {
  let endedReason = null;
  const call = Object.create(SipCall.prototype);
  Object.assign(call, {
    id: 'sip-no-ack-no-rtp',
    status: 'media_active',
    acknowledged: false,
    mediaConfirmedByRtp: false,
    rtp: { stats: () => ({ inboundPackets: 0 }) },
    sidecar: { logEvent: () => {} },
    end: (reason) => { endedReason = reason; },
  });

  call.handleAckTimeout();
  assert.equal(endedReason, 'ack_timeout');
});

test('post-greeting silence prompt is one-shot and cancelled by caller speech', () => {
  const prompts = [];
  const events = [];
  const call = Object.create(SipCall.prototype);
  Object.assign(call, {
    id: 'sip-post-greeting',
    direction: 'inbound',
    status: 'media_active',
    callerSpeechObserved: false,
    managerTransfer: null,
    postGreetingPromptTimer: null,
    postGreetingPromptScheduled: false,
    sidecar: {
      pbx: { postGreetingSilencePromptDelayMs: 2_000 },
      salesScenario: {
        postGreetingSilencePrompt: 'Вы бы хотели переговорить с каким-то конкретным сотрудником, или я могу вам чем-то помочь?',
      },
      logEvent: (type) => events.push(type),
    },
    rtp: { stats: () => ({ outboundQueuedBytes: 0 }) },
    openai: { requestResponse: (instructions) => { prompts.push(instructions); return true; } },
  });

  assert.equal(call.schedulePostGreetingPrompt(), true);
  assert.equal(call.schedulePostGreetingPrompt(), false);
  call.cancelPostGreetingPrompt();
  assert.equal(call.postGreetingPromptTimer, null);

  const prompt = call.sidecar.salesScenario.postGreetingSilencePrompt;
  assert.equal(call.sendPostGreetingPrompt(prompt), true);
  assert.match(prompts[0], /Вы бы хотели переговорить/u);
  assert.deepEqual(events, ['post_greeting_silence_prompt_started']);

  call.callerSpeechObserved = true;
  assert.equal(call.sendPostGreetingPrompt(prompt), false);
  assert.equal(prompts.length, 1);
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

test('outbound PCMU chunk queue preserves byte order across OpenAI deltas', () => {
  const packets = [];
  const rtp = new RtpSession({
    localIp: '127.0.0.1',
    port: 40203,
    remoteIp: '192.0.2.20',
    remotePort: 41000,
  });
  rtp.socket.send = (packet) => packets.push(packet);

  rtp.sendAudio(Buffer.alloc(100, 0x11));
  rtp.sendAudio(Buffer.alloc(100, 0x22));
  rtp.flushOutboundAudio();

  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0].subarray(12, 112), Buffer.alloc(100, 0x11));
  assert.deepEqual(packets[0].subarray(112), Buffer.alloc(60, 0x22));
  assert.equal(rtp.stats().outboundQueuedBytes, 40);

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

test('RTP transfer preparation waits for queued speech to finish', async () => {
  const rtp = Object.create(RtpSession.prototype);
  Object.assign(rtp, {
    outboundQueuedBytes: 320,
    closed: false,
  });
  setTimeout(() => { rtp.outboundQueuedBytes = 0; }, 30);

  const result = await rtp.waitForOutboundDrain({ timeoutMs: 500 });

  assert.equal(result.drained, true);
  assert.equal(result.initialBytes, 320);
  assert.equal(result.remainingBytes, 0);
  assert.ok(result.waitedMs >= 20);
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
  await sidecar.handleSip(Buffer.from(inDialogRequest('CANCEL', callId, 1, [
    ['Reason', 'SIP;cause=200;text="Call completed elsewhere"'],
  ])), { address: '192.0.2.10', port: 5060 });
  const call = await pending;

  assert.equal(call.status, 'ended');
  assert.equal(call.endReason, 'remote_cancel_completed_elsewhere');
  assert.equal(sidecar.callsBySipId.has(callId), false);
  assert.equal(sent.filter((msg) => msg.startLine === 'SIP/2.0 487 Request Terminated').length, 1);
  assert.equal(sent.filter((msg) => msg.startLine === 'SIP/2.0 200 OK').length, 1);
  const events = readFileSync(join(dir, 'events.jsonl'), 'utf8')
    .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(events.some((event) => event.type === 'call_setup_failed'), false);
  assert.equal(events.some((event) => event.type === 'call_setup_cancelled'), true);
});

test('pre-answer CANCEL finalizes a persisted SIP mission as cancelled', () => {
  const finalized = [];
  const sidecar = {
    transcriptPersistenceRequired: true,
    missionClient: { finalize: (missionId, body) => finalized.push({ missionId, body }) },
    logEvent: () => {},
    onCallEnded: () => {},
    sendBye: () => {},
    endManagerTransfer: () => {},
  };
  const call = new SipCall({ id: 'sip-cancelled', direction: 'inbound', sidecar });
  call.missionId = 'call-cancelled';

  call.end('remote_cancel');

  assert.equal(finalized[0].body.status, 'cancelled');
  assert.equal(finalized[0].body.reason, 'remote_cancel');
  assert.equal(finalized[0].body.metadata.transcriptTurnCount, 0);
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

test('guided TNVED consultation asks one question and then speaks an unblocked tariff result', async () => {
  const requests = [];
  const updates = [];
  const transcripts = [];
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.tnvedConsultationEnabled = true;
  sidecar.logEvent = () => {};
  sidecar.missionClient = {
    updateIntake: async (_missionId, patch) => {
      updates.push(patch);
      return { success: true, complete: false, intake: { missingFields: [] } };
    },
  };
  sidecar.requestTnved = async (path, options) => {
    requests.push({ path, options });
    if (path === '/tnved/classify') {
      return {
        draft: {
          request_id: '11111111-1111-1111-1111-111111111111',
          status: 'needs_clarification',
          best_candidate_preview: { code: '3919900000' },
          top3: [{ code: '3919900000' }],
        },
      };
    }
    return {
      advisory: {
        blocked: false,
        code: '3919900000',
        spoken_code: '3919 90 000 0',
        title: 'Пленка самоклеящаяся из пластмасс: прочая',
        spoken_title: 'Пленка самоклеящаяся из пластмасс, прочая',
        duty: { base: { note_key: 'duty-1', rate_text: '6.5 %' } },
        vat: { base: { note_key: 'vat-1', rate_text: '22 %' } },
        non_tariff: {
          status: 'ok',
          necessity: 'checks_identified',
          spoken_summary: 'Нужно проверить оценку соответствия.',
          source: 'CTM.GetCargoSpecFeatures',
          features: [],
        },
        payments: {
          status: 'calculated',
          duty_amount_rub: 6500,
          vat_amount_rub: 23430,
          duty_plus_vat_rub: 29930,
        },
        kb_version: 'kb_test',
      },
    };
  };
  const call = {
    id: 'sip-tnved-test',
    missionId: 'mission-tnved-test',
    tnvedConsultation: { fields: {}, requestId: null, lastAdvisory: null },
    recordSystemTranscript: (text, metadata) => transcripts.push({ text, metadata }),
  };

  const first = await sidecar.executeCallTool(call, 'consult_tnved', {
    productName: 'самоклеящаяся пленка ПЭТ',
  });
  assert.equal(first.ok, true);
  assert.equal(first.action, 'ask_question');
  assert.equal(first.field, 'purpose');
  assert.equal(requests.length, 0);

  const technicalQuestion = await sidecar.executeCallTool(call, 'consult_tnved', {
    productName: 'самоклеящаяся пленка ПЭТ',
    purpose: 'для изготовления этикеток',
    composition: 'полиэфирная пленка с акриловым клеем',
  });
  assert.equal(technicalQuestion.field, 'technicalParameters');
  assert.match(technicalQuestion.question, /ширину и толщину/u);
  assert.equal(requests.length, 0);

  const result = await sidecar.executeCallTool(call, 'consult_tnved', {
    productName: 'самоклеящаяся пленка ПЭТ',
    purpose: 'для изготовления этикеток',
    composition: 'полиэфирная пленка с акриловым клеем',
    technicalParameters: 'ширина 50 сантиметров, толщина 50 микрометров',
    processingStage: 'готовая пленка',
    packagingOrForm: 'в рулонах',
    originCountry: 'Китай',
    customsValueRub: 100000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'speak_result');
  assert.equal(result.result.code, '3919900000');
  assert.equal(result.result.spokenCode, '3919 90 000 0');
  assert.equal(result.result.wording, 'Пленка самоклеящаяся из пластмасс, прочая');
  assert.equal(result.result.importDuty.rate_text, '6.5 %');
  assert.equal(result.result.vat.rate_text, '22 %');
  assert.equal(result.result.payments.duty_plus_vat_rub, 29930);
  assert.deepEqual(requests.map((item) => item.path), [
    '/tnved/classify',
    '/tnved/classify/11111111-1111-1111-1111-111111111111/advisory',
  ]);
  assert.equal(updates[0].serviceTopic, 'customs');
  assert.match(updates[0].requestDescription, /3919900000/u);
  assert.equal(transcripts[0].metadata.kbVersion, 'kb_test');

  const vehicleStart = await sidecar.executeCallTool(call, 'consult_tnved', {
    restart: true,
    productName: 'легковой автомобиль',
  });
  assert.equal(vehicleStart.field, 'purpose');
  const vehicleTechnical = await sidecar.executeCallTool(call, 'consult_tnved', {
    productName: 'легковой автомобиль',
    purpose: 'для личного использования',
  });
  assert.equal(vehicleTechnical.field, 'technicalParameters');
  assert.match(vehicleTechnical.question, /марку, модель, год выпуска/u);
  assert.equal(requests.length, 2);
});

test('TNVED transport preserves Russian JSON through the base64 wire format', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    };
  };

  try {
    const sidecar = Object.create(SipSidecar.prototype);
    sidecar.tnvedApiBase = 'http://tnved.test';
    const product = { name: 'самоклеящаяся пленка ПЭТ' };
    const result = await sidecar.requestTnved('/tnved/classify', {
      method: 'POST',
      body: product,
    });

    assert.equal(result.status, 'ok');
    assert.equal(captured.url, 'http://tnved.test/tnved/classify');
    assert.equal(captured.options.headers['Content-Type'], 'application/octet-stream');
    assert.equal(
      captured.options.headers['X-TNVED-Body-Encoding'],
      'masked-gzip-base64-v1',
    );
    const wire = Buffer.from(captured.options.body, 'base64');
    const expectedDigest = wire.subarray(0, 32);
    const masked = wire.subarray(32);
    const mask = createHash('sha256').update('TNVED UTF8 transport mask v1', 'utf8').digest();
    const compressed = Buffer.allocUnsafe(masked.length);
    for (let index = 0; index < masked.length; index += 1) {
      compressed[index] = masked[index] ^ mask[index % mask.length];
    }
    assert.deepEqual(createHash('sha256').update(compressed).digest(), expectedDigest);
    assert.deepEqual(
      JSON.parse(gunzipSync(compressed).toString('utf8')),
      product,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('TNVED chapter gate blocks an unrelated code for a truck before speech', async () => {
  const updates = [];
  const transcripts = [];
  const events = [];
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.tnvedConsultationEnabled = true;
  sidecar.logEvent = (type, payload) => events.push({ type, payload });
  sidecar.missionClient = {
    updateIntake: async (_missionId, patch) => {
      updates.push(patch);
      return { success: true };
    },
  };
  sidecar.requestTnved = async (path) => {
    if (path === '/tnved/classify') {
      return {
        draft: {
          request_id: '44444444-4444-4444-4444-444444444444',
          best_candidate_preview: { code: '2309101100' },
          top3: [{ code: '2309101100' }],
        },
      };
    }
    return {
      advisory: {
        code: '2309101100',
        kb_version: 'kb_test',
        duty: { base: { rate_text: '10 %' } },
        vat: { base: { rate_text: '22 %' } },
        payments: { status: 'calculated', duty_plus_vat_rub: 1000 },
      },
    };
  };
  const call = {
    id: 'sip-truck-gate-test',
    missionId: 'mission-truck-gate-test',
    tnvedConsultation: { fields: {}, requestId: null, lastAdvisory: null },
    recordSystemTranscript: (text, metadata) => transcripts.push({ text, metadata }),
  };
  const result = await sidecar.consultTnved(call, {
    productName: 'седельный тягач Volvo FH категории N3',
    purpose: 'буксировка полуприцепа',
    technicalParameters: '2024 год, дизель, 12777 куб. см, 500 л.с.',
    originCountry: 'Швеция',
    customsValueRub: 10000000,
    finishNow: true,
  });
  assert.equal(result.action, 'offer_followup', JSON.stringify(events));
  assert.doesNotMatch(JSON.stringify(result), /2309101100|10 %|1000/u);
  assert.match(result.message, /info собака nbr точка ru/u);
  assert.equal(call.tnvedConsultation.lastAdvisory, null);
  assert.equal(transcripts[0].metadata.rejectedCode, '2309101100');
  assert.equal(updates[0].nextAction.owner, 'customs_certification');
});

test('vehicle customs tool keeps answers, resolves a CTM code, and persists the calculation', async () => {
  const requests = [];
  const updates = [];
  const transcripts = [];
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.vehicleCustomsEnabled = true;
  sidecar.logEvent = () => {};
  sidecar.missionClient = {
    updateIntake: async (_missionId, patch) => {
      updates.push(patch);
      return { success: true, complete: false, intake: { missingFields: [] } };
    },
  };
  sidecar.requestTnved = async (path, options) => {
    requests.push({ path, options });
    if (path === '/vehicle/customs/calculate' && !options.body.import_route) {
      return {
        calculation: {
          status: 'needs_clarification',
          action: 'ask_one_question',
          next_field: 'import_route',
          missing_fields: ['import_route'],
          question: 'Откуда ввозится автомобиль?',
        },
      };
    }
    if (path === '/vehicle/customs/calculate' && !options.body.tnved_code) {
      return {
        calculation: {
          status: 'needs_clarification',
          action: 'ask_one_question',
          next_field: 'duty_rate_percent',
          missing_fields: ['tnved_code', 'duty_rate_percent'],
          question: 'Нужен проверенный код ТН ВЭД.',
        },
      };
    }
    if (path === '/tnved/classify') {
      return {
        draft: {
          request_id: '33333333-3333-3333-3333-333333333333',
          best_candidate_preview: { code: '8703800002' },
        },
      };
    }
    if (path.endsWith('/advisory')) {
      return { advisory: { code: '8703800002' } };
    }
    return {
      calculation: {
        status: 'calculated',
        action: 'speak_result',
        rate_version: 'ru_vehicle_customs_2026_v1',
        calculation_hash: 'a'.repeat(64),
        spoken_summary: 'Обязательные платежи всего: 5 000 000 рублей.',
        input_summary: { calculation_route: 'third_country' },
        customs_payment: { payment_type: 'aggregate_customs_payment', amount_rub: 3000000 },
        customs_fee: { amount_rub: 49240 },
        recycling_fee: { amount_rub: 1950760 },
        recycling_fee_alternative: null,
        additional_expenses: { items: [], total_rub: 0 },
        totals: { mandatory_total_rub: 5000000 },
        warnings: ['Дополнительные расходы не включены.'],
        tariff_trace: { code: '8703800002' },
      },
    };
  };
  const call = {
    id: 'sip-vehicle-test',
    missionId: 'mission-vehicle-test',
    vehicleCustomsCalculation: {
      fields: {},
      classificationRequestId: null,
      lastCalculation: null,
    },
    recordSystemTranscript: (text, metadata) => transcripts.push({ text, metadata }),
  };

  const first = await sidecar.executeCallTool(call, 'calculate_vehicle_customs', {
    vehicleModel: 'Tesla Model Y',
  });
  assert.equal(first.action, 'ask_question');
  assert.equal(first.field, 'import_route');
  assert.equal(requests.length, 1);

  const result = await sidecar.executeCallTool(call, 'calculate_vehicle_customs', {
    vehicleModel: 'Tesla Model Y',
    importRoute: 'third_country',
    vehicleCategory: 'M1',
    importerType: 'legal_entity',
    purpose: 'business_or_resale',
    ageCategory: 'up_to_3_years',
    propulsion: 'bev',
    powerHp: 300,
    vehiclePriceAmount: 50000,
    vehiclePriceCurrency: 'USD',
    borderCostsKnown: true,
    borderCostsIncludedInPrice: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'speak_result');
  assert.equal(result.result.tnvedCode, '8703800002');
  assert.equal(result.result.totals.mandatory_total_rub, 5000000);
  assert.deepEqual(requests.map((item) => item.path), [
    '/vehicle/customs/calculate',
    '/vehicle/customs/calculate',
    '/tnved/classify',
    '/tnved/classify/33333333-3333-3333-3333-333333333333/advisory',
    '/vehicle/customs/calculate',
  ]);
  assert.equal(
    requests.at(-1).options.body.tnved_code,
    '8703800002',
  );
  assert.equal(updates[0].serviceTopic, 'vehicle_customs');
  assert.match(updates[0].requestDescription, /Расчетный хеш/u);
  assert.equal(transcripts[0].metadata.calculationHash, 'a'.repeat(64));
});

test('non-M1 vehicle categories are rerouted to TNVED without calling the M1 calculator', async () => {
  const transcripts = [];
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.vehicleCustomsEnabled = true;
  sidecar.logEvent = () => {};
  sidecar.requestTnved = async () => {
    throw new Error('M1 API must not be called for N3');
  };
  const call = {
    id: 'sip-n3-customs-test',
    vehicleCustomsCalculation: {
      fields: {},
      classificationRequestId: null,
      lastCalculation: null,
    },
    recordSystemTranscript: (text, metadata) => transcripts.push({ text, metadata }),
  };
  const result = await sidecar.calculateVehicleCustoms(call, {
    vehicleModel: 'седельный тягач Volvo FH',
    vehicleCategory: 'N3',
    manufactureDate: '2024-01-01',
    propulsion: 'ice_diesel',
    engineCc: 12777,
    powerHp: 500,
    originCountry: 'Швеция',
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'continue_with_tnved');
  assert.equal(result.nextTool, 'consult_tnved');
  assert.match(result.suggestedArguments.productName, /грузовой автомобиль категории N3/u);
  assert.match(result.suggestedArguments.technicalParameters, /12777 куб\. см/u);
  assert.equal(result.suggestedArguments.originCountry, 'Швеция');
  assert.match(result.instruction, /не применяйте матрицу M1/u);
  assert.equal(transcripts[0].metadata.vehicleCategory, 'N3');
});

test('freight estimate tool keeps answers and exposes amounts only after the full second-pass gate', async () => {
  const requests = [];
  const updates = [];
  const transcripts = [];
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.freightRateCalculationEnabled = true;
  sidecar.logEvent = () => {};
  sidecar.missionClient = {
    updateIntake: async (_missionId, patch) => {
      updates.push(patch);
      return { success: true, complete: false, intake: { missingFields: [] } };
    },
  };
  sidecar.requestFreightRate = async (path, options) => {
    requests.push({ path, options });
    if (!options.body.origin) {
      return {
        ok: true,
        action: 'ask_question',
        field: 'origin',
        question: 'Откуда нужно забрать груз?',
      };
    }
    return {
      ok: true,
      action: 'speak_result',
      estimate_id: 'fvest_test',
      release_status: 'VERIFIED_FOR_SPEECH',
      spoken_summary: 'Предварительный ориентир составляет от 4 000 до 4 200 долларов США.',
      range_low: 4000,
      range_high: 4200,
      source_count: 3,
      calculation_hash: 'c'.repeat(64),
      verification_hash: 'v'.repeat(64),
      verification: {
        internal_snapshot_unchanged: true,
        initial_web_search_completed: true,
        independent_web_verification_completed: true,
        all_used_external_sources_rechecked: true,
        independent_source_count: 3,
        blockers: [],
      },
    };
  };
  const call = {
    id: 'sip-freight-test',
    missionId: 'mission-freight-test',
    freightRateCalculation: { fields: {}, lastEstimate: null },
    recordSystemTranscript: (text, metadata) => transcripts.push({ text, metadata }),
  };

  const first = await sidecar.executeCallTool(call, 'calculate_freight_estimate', {
    mode: 'ocean_fcl',
  });
  assert.equal(first.action, 'ask_question');
  assert.equal(first.field, 'origin');

  const result = await sidecar.executeCallTool(call, 'calculate_freight_estimate', {
    origin: 'Shanghai',
    destination: 'Saint Petersburg',
    cargoDescription: 'Industrial equipment',
    readyDate: '2026-07-30',
    scope: 'port to port',
    dgStatus: 'non-dangerous',
    equipment: '40HC',
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'speak_result');
  assert.equal(result.result.releaseStatus, 'VERIFIED_FOR_SPEECH');
  assert.match(result.result.spokenSummary, /4 000/u);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.body.mode, 'ocean_fcl');
  assert.equal(updates[0].serviceTopic, 'ocean_freight');
  assert.equal(transcripts[0].metadata.verificationHash, 'v'.repeat(64));
  assert.equal(result.documentSubmission.email, 'info@nbr.ru');
  assert.equal(result.documentSubmission.subjectMark, 'для Елены');
});

test('freight estimate tool strips unverified amounts and gives the Elena document fallback', async () => {
  const updates = [];
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.freightRateCalculationEnabled = true;
  sidecar.logEvent = () => {};
  sidecar.missionClient = {
    updateIntake: async (_missionId, patch) => {
      updates.push(patch);
      return { success: true };
    },
  };
  sidecar.requestFreightRate = async () => ({
    ok: true,
    action: 'offer_followup',
    release_status: 'REFERENCE_ONLY',
    spoken_summary: 'A hidden candidate was 9 999 USD.',
    range_low: 9999,
    range_high: 9999,
    currency: 'USD',
    calculation_hash: 'c'.repeat(64),
    verification_hash: 'v'.repeat(64),
    verification: {
      internal_snapshot_unchanged: true,
      initial_web_search_completed: true,
      independent_web_verification_completed: true,
      all_used_external_sources_rechecked: false,
      independent_source_count: 1,
      blockers: ['NOT_ALL_INITIAL_EXTERNAL_SOURCES_RECHECKED'],
    },
  });
  const call = {
    id: 'sip-freight-blocked-test',
    missionId: 'mission-freight-blocked-test',
    freightRateCalculation: { fields: {}, lastEstimate: null },
    recordSystemTranscript: () => {},
  };

  const result = await sidecar.executeCallTool(call, 'calculate_freight_estimate', {
    mode: 'ocean_fcl',
    origin: 'Shanghai',
    destination: 'Saint Petersburg',
    cargoDescription: 'Industrial equipment',
    readyDate: '2026-07-30',
    scope: 'port to port',
    dgStatus: 'non-dangerous',
    equipment: '40HC',
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.action, 'offer_followup');
  assert.doesNotMatch(serialized, /9 999|9999|USD/u);
  assert.match(result.message, /info собака nbr точка ru/u);
  assert.match(result.message, /для Елены/u);
  assert.equal(updates[0].nextAction.notes.includes('info@nbr.ru'), true);
});

test('Nevsky Broker service cost tool uses configured base maximum rates', async () => {
  const updates = [];
  const transcripts = [];
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.nbrServiceRates = testNbrServiceRates();
  sidecar.logEvent = () => {};
  sidecar.missionClient = {
    updateIntake: async (_missionId, patch) => {
      updates.push(patch);
      return { success: true, complete: false, intake: { missingFields: [] } };
    },
  };
  const call = {
    id: 'sip-nbr-service-cost-test',
    missionId: 'mission-nbr-service-cost-test',
    nbrServiceCostCalculation: { fields: {}, lastResult: null },
    recordSystemTranscript: (text, metadata) => transcripts.push({ text, metadata }),
  };

  const result = await sidecar.executeCallTool(call, 'calculate_nbr_service_cost', {
    serviceScenario: 'sea_import_client_ep_containers',
    containerCount: 12,
    serviceLines: [
      { code: 'C11', quantity: 12, note: 'port forwarding' },
      { code: 'C14', quantity: 12, note: 'terminal handling' },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'speak_result');
  assert.equal(result.result.totalAmountRub, 352000);
  assert.equal(result.result.currency, 'RUB');
  assert.equal(result.result.lines.find((line) => line.code === 'C01').quantity, 1);
  assert.equal(result.result.lines.find((line) => line.code === 'C02').quantity, 9);
  assert.equal(result.result.lines.find((line) => line.code === 'C03').quantity, 2);
  assert.equal(result.result.lines.find((line) => line.code === 'C04').quantity, 11);
  assert.match(result.result.spokenSummary, /352 000/u);
  assert.match(result.instruction, /государственных таможенных платежей/u);
  assert.equal(updates[0].requestType, 'service');
  assert.equal(updates[0].serviceTopic, 'port_forwarding');
  assert.equal(transcripts[0].metadata.toolName, 'calculate_nbr_service_cost');
  assert.equal(transcripts[0].metadata.totalRub, 352000);
});

test('Nevsky Broker service cost tool asks container count for tiered container scenarios', async () => {
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.nbrServiceRates = testNbrServiceRates();
  sidecar.logEvent = () => {};
  sidecar.missionClient = {
    updateIntake: async () => ({ success: true }),
  };
  const call = {
    id: 'sip-nbr-service-cost-missing-test',
    missionId: 'mission-nbr-service-cost-missing-test',
    recordSystemTranscript: () => {},
  };

  const result = await sidecar.executeCallTool(call, 'calculate_nbr_service_cost', {
    serviceScenario: 'client_ep_customs_containers',
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'ask_question');
  assert.equal(result.field, 'containerCount');
});

test('assisted manager transfer returns to Elena after no answer and records callback follow-up', async () => {
  const updates = [];
  const autoResponse = [];
  const rtpClosed = [];
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.pbx = {
    managerExtensions: { sales: '135' },
    managerTransferTimeoutSeconds: 15,
    managerTransferNoAnswerMessage: 'Менеджер сейчас не смог ответить. Отправьте детали на sales собака nbr точка ru.',
  };
  sidecar.server = 'pbx.test';
  sidecar.port = 5060;
  sidecar.username = '199';
  sidecar.localIp = '127.0.0.1';
  sidecar.managerLegsBySipId = new Map();
  sidecar.allocateRtpPort = () => 40220;
  sidecar.createRtpSession = () => ({
    start: async () => {},
    close: () => rtpClosed.push(true),
  });
  sidecar.sendManagerInvite = async () => ({ connected: false, status: 'no_answer' });
  sidecar.logEvent = () => {};
  sidecar.missionClient = {
    updateIntake: async (_missionId, patch) => {
      updates.push(patch);
      return { success: true, complete: false, intake: { missingFields: [] } };
    },
  };
  const call = {
    id: 'sip-transfer-timeout',
    missionId: 'mission-transfer-timeout',
    dialogEstablished: true,
    acknowledged: true,
    status: 'media_active',
    managerTransfer: null,
    rtp: { clearOutboundAudio: () => {} },
    openai: { setAutoResponseEnabled: (enabled) => autoResponse.push(enabled) },
    recordSystemTranscript: () => {},
  };

  const result = await sidecar.executeCallTool(call, 'transfer_to_manager', {
    route: 'sales', reason: 'Caller requested a manager',
  });

  assert.equal(result.ok, true);
  assert.equal(result.transferStatus, 'no_answer');
  assert.equal(result.connected, false);
  assert.equal(result.callbackRecorded, true);
  assert.match(result.responseInstructions, /sales собака nbr точка ru/u);
  assert.deepEqual(autoResponse, [false, true]);
  assert.equal(rtpClosed.length, 1);
  assert.equal(call.status, 'media_active');
  assert.equal(call.managerTransfer, null);
  assert.equal(updates[0].nextAction.type, 'callback_request');
  assert.equal(updates[0].nextAction.owner, 'sales');
  assert.equal(updates[0].outcome, 'needs_follow_up');
});

test('assisted manager transfer switches to the manager only after answer', async () => {
  const updates = [];
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.pbx = { managerExtensions: { sales: '135' }, managerTransferTimeoutSeconds: 15 };
  sidecar.server = 'pbx.test';
  sidecar.port = 5060;
  sidecar.username = '199';
  sidecar.localIp = '127.0.0.1';
  sidecar.managerLegsBySipId = new Map();
  sidecar.allocateRtpPort = () => 40222;
  sidecar.createRtpSession = () => ({ start: async () => {}, close: () => {} });
  sidecar.sendManagerInvite = async () => ({ connected: true, status: 'connected' });
  sidecar.logEvent = () => {};
  sidecar.missionClient = {
    updateIntake: async (_missionId, patch) => {
      updates.push(patch);
      return { success: true, complete: true, intake: { missingFields: [] } };
    },
  };
  const call = {
    id: 'sip-transfer-connected',
    missionId: 'mission-transfer-connected',
    dialogEstablished: true,
    acknowledged: true,
    status: 'media_active',
    managerTransfer: null,
    rtp: { clearOutboundAudio: () => {} },
    openai: { setAutoResponseEnabled: () => {} },
    recordSystemTranscript: () => {},
  };

  const result = await sidecar.executeCallTool(call, 'transfer_to_manager', {
    route: 'sales', reason: 'Caller requested a manager',
  });

  assert.equal(result.ok, true);
  assert.equal(result.transferStatus, 'connected');
  assert.equal(result.connected, true);
  assert.equal(result.suppressResponse, true);
  assert.equal(call.status, 'manager_connected');
  assert.equal(call.managerTransfer.extension, '135');
  assert.equal(updates[0].nextAction.type, 'transfer');
  assert.equal(updates[0].outcome, 'transferred');
});

test('topic manager routes rotate between employees in the configured department', async () => {
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.username = '199';
  sidecar.managerRouteCursor = new Map();
  sidecar.pbx = {
    managerRoutes: {
      logistics: {
        label: 'Логистика',
        selection: 'round_robin',
        topics: ['международные перевозки', 'внутрироссийские перевозки'],
        destinations: [
          { extension: '171', employee: 'Viktoria E.', aliases: ['Виктория Е'] },
          { extension: '173', employee: 'Sergey O.', aliases: ['Сергей О'] },
        ],
      },
    },
    managerTransferTimeoutSeconds: 15,
  };
  sidecar.transferToDestination = async (_call, destination) => destination;

  const first = await sidecar.transferToManager({}, 'logistics', 'International freight request');
  const second = await sidecar.transferToManager({}, 'logistics', 'Domestic freight request');
  const third = await sidecar.transferToManager({}, 'logistics', 'Ocean freight request');

  assert.equal(first.extension, '171');
  assert.equal(first.owner, 'Viktoria E.');
  assert.equal(first.destinationType, 'named_route');
  assert.equal(second.extension, '173');
  assert.equal(second.owner, 'Sergey O.');
  assert.equal(third.extension, '171');
});

test('explicitly named employee overrides round robin without guessing an ambiguous name', async () => {
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.username = '199';
  sidecar.managerRouteCursor = new Map();
  sidecar.pbx = {
    managerRoutes: {
      customs_certification: {
        label: 'Таможенное оформление и сертификация',
        selection: 'round_robin',
        destinations: [
          { extension: '145', employee: "Natal'ya E.", aliases: ['Наталья Е', 'Natalya E'] },
          { extension: '147', employee: 'Natalia B.', aliases: ['Наталия Б', 'Наталья Б'] },
        ],
      },
    },
  };
  sidecar.transferToDestination = async (_call, destination) => destination;

  const named = await sidecar.transferToManager(
    {},
    'customs_certification',
    'Caller requested Natalia B.',
    'Наталья Б',
  );
  const ambiguous = await sidecar.transferToManager(
    {},
    'customs_certification',
    'Caller requested Natalia without an initial',
    'Наталья',
  );

  assert.equal(named.extension, '147');
  assert.equal(named.owner, 'Natalia B.');
  assert.equal(named.destinationType, 'named_employee');
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /not configured or allowlisted/u);
});

test('legacy sales and operator route aliases resolve to customer service', async () => {
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.username = '199';
  sidecar.managerRouteCursor = new Map();
  sidecar.pbx = {
    managerRouteAliases: {
      sales: 'customer_service',
      operator: 'customer_service',
    },
    managerRoutes: {
      customer_service: {
        selection: 'primary',
        destinations: [{ extension: '135', employee: 'Irina A.', aliases: ['Ирина'] }],
      },
    },
  };
  sidecar.transferToDestination = async (_call, destination) => destination;

  const sales = await sidecar.transferToManager({}, 'sales', 'Generic manager request');
  const operator = await sidecar.transferToManager({}, 'operator', 'Operator request');

  assert.equal(sales.route, 'customer_service');
  assert.equal(sales.extension, '135');
  assert.equal(operator.route, 'customer_service');
  assert.equal(operator.extension, '135');
});

test('caller-confirmed internal extension transfer connects only after answer', async () => {
  const updates = [];
  const sequence = [];
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.pbx = {
    internalTransfer: {
      enabled: true,
      allowedExtensionPattern: '^1[0-9]{2}$',
      blockedExtensions: ['199'],
      timeoutSeconds: 15,
    },
  };
  sidecar.server = 'pbx.test';
  sidecar.port = 5060;
  sidecar.username = '199';
  sidecar.localIp = '127.0.0.1';
  sidecar.managerLegsBySipId = new Map();
  sidecar.allocateRtpPort = () => 40224;
  sidecar.createRtpSession = () => ({ start: async () => {}, close: () => {} });
  sidecar.sendManagerInvite = async (_call, leg) => {
    sequence.push('invite');
    assert.equal(leg.extension, '114');
    return { connected: true, status: 'connected' };
  };
  sidecar.logEvent = () => {};
  sidecar.missionClient = {
    updateIntake: async (_missionId, patch) => {
      updates.push(patch);
      return { success: true, complete: true, intake: { missingFields: [] } };
    },
  };
  const call = {
    id: 'sip-extension-connected',
    missionId: 'mission-extension-connected',
    dialogEstablished: true,
    acknowledged: true,
    status: 'media_active',
    managerTransfer: null,
    rtp: {
      stats: () => ({ outboundQueuedBytes: 320 }),
      waitForOutboundDrain: async () => {
        sequence.push('drain');
        return { drained: true, initialBytes: 320, remainingBytes: 0, waitedMs: 40 };
      },
      clearOutboundAudio: () => sequence.push('clear'),
    },
    openai: { setAutoResponseEnabled: () => {} },
    recordSystemTranscript: () => {},
  };

  const result = await sidecar.executeCallTool(call, 'transfer_to_extension', {
    extension: '114', reason: 'Caller explicitly requested and confirmed extension 114',
  });

  assert.equal(result.ok, true);
  assert.equal(result.transferStatus, 'connected');
  assert.equal(result.destinationType, 'direct_extension');
  assert.equal(result.connected, true);
  assert.deepEqual(sequence, ['drain', 'clear', 'invite']);
  assert.equal(call.managerTransfer.extension, '114');
  assert.equal(updates[0].nextAction.owner, 'extension:114');
  assert.equal(updates[0].outcome, 'transferred');
});

test('direct extension transfer blocks self, external and non-allowlisted numbers', async () => {
  const sidecar = Object.create(SipSidecar.prototype);
  sidecar.username = '199';
  sidecar.pbx = {
    internalTransfer: {
      enabled: true,
      allowedExtensionPattern: '^1[0-9]{2}$',
      blockedExtensions: ['199'],
    },
  };

  for (const extension of ['199', '099', '200', '911', '88122411844', '+78122411844']) {
    const result = await sidecar.transferToInternalExtension({}, extension, 'test');
    assert.equal(result.ok, false, extension);
    assert.match(result.error, /not allowlisted/u);
  }
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
    managerRoutes: {
      customer_service: {
        label: 'Отдел по работе с клиентами',
        selection: 'round_robin',
        topics: ['общие вопросы', 'вопросы без конкретизации'],
        destinations: [
          { extension: '135', employee: 'Irina A.', aliases: ['Ирина'] },
          { extension: '136', employee: 'Marina S.', aliases: ['Марина'] },
        ],
      },
    },
  }));
  writeFileSync(agenticmailConfigPath, JSON.stringify({}));

  const sidecar = new SipSidecar({ configPath, agenticmailConfigPath });
  t.after(() => {
    try { sidecar.socket.close(); } catch { /* socket was never bound */ }
  });

  const routingPrompt = sidecar.buildInstructions({ direction: 'inbound', loadedSkills: [] });
  assert.equal(
    sidecar.salesScenario.openings.inbound,
    'Здравствуйте. Невский Брокер, меня зовут Елена, слушаю вас.',
  );
  assert.equal(sidecar.salesScenario.id, 'nevsky-broker-sales-intake-v17');
  assert.equal(sidecar.salesScenario.version, 17);
  assert.doesNotMatch(sidecar.salesScenario.openings.inbound, /ИИ-помощник/u);
  assert.match(routingPrompt, /# Routing/);
  assert.match(routingPrompt, /# Internal Department Routing Directory/u);
  assert.match(routingPrompt, /route customer_service/u);
  assert.match(routingPrompt, /Irina A\., Marina S\./u);
  assert.doesNotMatch(routingPrompt, /extension 135/u);
  assert.match(routingPrompt, /Я виртуальный голосовой помощник/u);
  assert.match(routingPrompt, /не обманывай и не уклоняйся/u);
  assert.match(routingPrompt, /# Live Freight Rate Estimate/u);
  assert.match(routingPrompt, /# Mandatory Early Customs Router/u);
  assert.match(routingPrompt, /N1\/N2\/N3/u);
  assert.match(routingPrompt, /consult_tnved/u);
  assert.match(routingPrompt, /VERIFIED_FOR_SPEECH/u);
  assert.match(routingPrompt, /info собака nbr точка ru/u);
  assert.match(routingPrompt, /для Елены/u);
  assert.doesNotMatch(routingPrompt, /голосовой ИИ-помощник/u);
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

  const vehiclePrompt = sidecar.buildInstructions({
    direction: 'inbound',
    loadedSkills: [],
    specialistRoute: { relationship: 'new_customer', requestType: 'service', serviceTopic: 'vehicle_customs' },
  });
  assert.match(vehiclePrompt, /мотоцикл/u);
  assert.match(vehiclePrompt, /sales@nbr\.ru/u);
  assert.match(vehiclePrompt, /sales собака nbr точка ru/u);
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
  const health = sidecar.health();
  assert.deepEqual(health.voice, {
    provider: 'openai',
    model: 'gpt-realtime-2.1',
    name: 'coral',
    speed: 1.20,
    language: 'ru',
    persona: 'Елена',
    personaGender: 'female',
  });
  assert.deepEqual(health.audioStability, {
    revision: 'rtp-stability-v2',
    outboundBuffer: 'chunk_queue',
    responseSerialization: true,
    highFrequencyAudioAuditLogging: false,
    severePacerLateThresholdMs: 100,
  });
  assert.equal(health.salesScenario.detailedRequestEmail, 'sales@nbr.ru');
  assert.equal(health.salesScenario.documentSubmissionEmail, 'info@nbr.ru');
  assert.equal(health.salesScenario.documentSubmissionMark, 'для Елены');
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

test('empty transcript spool still probes persistence health', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenticmail-sip-health-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probes = [];
  const client = new AgenticMailSipMissionClient({
    apiBase: 'http://127.0.0.1:1',
    masterKey: 'test-master-key',
    agent: 'sales@localhost',
    spoolPath: join(dir, 'spool.enc.jsonl'),
  });
  t.after(() => client.close());
  client.request = async (path) => {
    probes.push(path);
    return { ok: true };
  };

  await client.flushSpool();
  assert.equal(client.status().ready, true);
  assert.match(probes[0], /persistence-health/u);

  client.request = async () => { throw new TypeError('fetch failed'); };
  await client.flushSpool();
  assert.equal(client.status().ready, false);
  assert.match(client.status().lastError, /fetch failed/u);
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

test('Realtime request errors retain diagnostic metadata without closing the bridge', () => {
  const events = [];
  const bridge = new OpenAiRealtimeBridge({
    apiKey: 'test', model: 'gpt-realtime-2.1', voice: 'marin', instructions: 'test',
    onEvent: (event) => events.push(event),
  });
  bridge.ready = true;
  bridge.handleMessage(JSON.stringify({
    type: 'error',
    event_id: 'event-1',
    error: {
      type: 'invalid_request_error',
      code: 'conversation_already_has_active_response',
      message: 'A response is already active.',
    },
  }));

  assert.equal(bridge.ready, true);
  assert.deepEqual(events[0], {
    type: 'error',
    text: 'A response is already active.',
    errorCode: 'conversation_already_has_active_response',
    errorCategory: 'invalid_request_error',
    eventId: 'event-1',
  });
});

test('Realtime bridge waits for response.done before speaking a tool result', async () => {
  const sent = [];
  const bridge = new OpenAiRealtimeBridge({
    apiKey: 'test',
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    instructions: 'test',
    onToolCall: async () => ({ ok: true }),
  });
  bridge.ready = true;
  bridge.ws = { readyState: 1, send: (value) => sent.push(JSON.parse(value)) };
  bridge.handleMessage(JSON.stringify({
    type: 'response.created',
    response: { id: 'resp_active', status: 'in_progress' },
  }));

  await bridge.dispatchToolCall({ call_id: 'tool-1', name: 'lookup', arguments: '{}' });

  assert.equal(sent.some((event) => event.type === 'conversation.item.create'), true);
  assert.equal(sent.some((event) => event.type === 'response.create'), false);
  assert.equal(bridge.stats().queuedResponse, true);

  bridge.handleMessage(JSON.stringify({
    type: 'response.done',
    response: { id: 'resp_active', status: 'completed' },
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.filter((event) => event.type === 'response.create').length, 1);
  assert.equal(bridge.stats().queuedResponse, false);
  assert.equal(bridge.stats().completed, 1);
});

test('Realtime bridge retries a response.create rejected by an automatic VAD response', async () => {
  const sent = [];
  const bridge = new OpenAiRealtimeBridge({
    apiKey: 'test',
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    instructions: 'test',
  });
  bridge.ready = true;
  bridge.ws = { readyState: 1, send: (value) => sent.push(JSON.parse(value)) };

  assert.equal(bridge.requestResponse('Speak after the active response.'), true);
  const firstCreate = sent.find((event) => event.type === 'response.create');
  bridge.handleMessage(JSON.stringify({
    type: 'response.created',
    response: { id: 'resp_vad', status: 'in_progress' },
  }));
  bridge.handleMessage(JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      code: 'conversation_already_has_active_response',
      event_id: firstCreate.event_id,
      message: 'A response is already active.',
    },
  }));
  bridge.handleMessage(JSON.stringify({
    type: 'response.done',
    response: { id: 'resp_vad', status: 'completed' },
  }));
  await new Promise((resolve) => setImmediate(resolve));

  const creates = sent.filter((event) => event.type === 'response.create');
  assert.equal(creates.length, 2);
  assert.equal(creates[1].response.instructions, 'Speak after the active response.');
  assert.equal(bridge.stats().activeResponseConflicts, 1);
});

test('high-frequency Realtime audio deltas are not synchronously audit-logged', () => {
  const logged = [];
  const sidecar = {
    logEvent: (...args) => logged.push(args),
  };

  SipSidecar.prototype.recordOpenAiEvent.call(
    sidecar,
    { id: 'call-audio' },
    { type: 'response.output_audio.delta', audioBytes: 160 },
  );
  assert.equal(logged.length, 0);

  SipSidecar.prototype.recordOpenAiEvent.call(
    sidecar,
    { id: 'call-audio' },
    { type: 'response.done', responseId: 'resp-1', responseStatus: 'completed' },
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], 'call_event');
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
  assert.equal(bridge.setAutoResponseEnabled(false), true);
  assert.equal(sent[2].type, 'session.update');
  assert.equal(sent[2].session.audio.input.turn_detection.create_response, false);
});

test('playback truncation is bounded by generated audio duration', () => {
  const output = {
    outboundStreamStart: 1_000,
    generatedAudioBytes: 80_000,
  };

  assert.equal(playbackTruncationMs(output, { outboundBytes: 41_000 }), 5_000);
  assert.equal(playbackTruncationMs(output, { outboundBytes: 1_000 }), null);
  assert.equal(playbackTruncationMs(output, { outboundBytes: 81_000 }), null);
  assert.equal(playbackTruncationMs(output, { outboundBytes: 120_680 }), null);
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

test('Realtime tool result can require one deterministic fallback response', async () => {
  const sent = [];
  const bridge = new OpenAiRealtimeBridge({
    apiKey: 'test', model: 'gpt-realtime-2.1', voice: 'marin', instructions: 'test',
    onToolCall: async () => ({
      ok: true,
      responseInstructions: 'Скажите дословно: «Отправьте детали на sales собака nbr точка ru».',
    }),
  });
  bridge.ready = true;
  bridge.ws = { readyState: 1, send: (value) => sent.push(JSON.parse(value)) };

  await bridge.dispatchToolCall({ call_id: 'transfer-1', name: 'transfer_to_manager', arguments: '{}' });

  const response = sent.find((event) => event.type === 'response.create');
  assert.deepEqual(response.response.output_modalities, ['audio']);
  assert.match(response.response.instructions, /sales собака nbr точка ru/u);
});
