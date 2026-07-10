import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RtpSession, SipSidecar, buildSipMessage, parseSipMessage } from './sip-sidecar.mjs';

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
