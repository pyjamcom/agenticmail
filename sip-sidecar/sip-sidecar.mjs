#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';

const DEFAULT_CONFIG_PATH = join(os.homedir(), '.agenticmail', 'pbx199.local.json');
const DEFAULT_AGENTICMAIL_CONFIG_PATH = join(os.homedir(), '.agenticmail', 'config.json');
const DEFAULT_MODEL = 'gpt-realtime-2.1';
const DEFAULT_VOICE = 'marin';
const DEFAULT_SIP_PORT = 5070;
const DEFAULT_RTP_MIN = 40200;
const DEFAULT_RTP_MAX = 40398;
const DEFAULT_HTTP_PORT = 3899;
const REGISTER_EXPIRES_SECONDS = 60;
const REGISTER_RENEW_SECONDS = 45;
const RTP_PACKET_BYTES = 160;
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function readJson(path, fallback = {}) {
  if (!path || !existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function md5(value) {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

function randomHex(bytes = 8) {
  return randomBytes(bytes).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function asInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function redactNumber(value) {
  const s = String(value ?? '');
  if (s.length <= 5) return '<redacted>';
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function appendJsonl(path, record) {
  ensureDir(path);
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

function loadDpapiSecret(path) {
  if (!path || !existsSync(path)) return '';
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$raw = (Get-Content -LiteralPath '${path.replace(/'/g, "''")}' -Raw).Trim()`,
    '$secure = $raw | ConvertTo-SecureString',
    '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }',
    'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
  ].join('\n');
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  if (result.status !== 0) return '';
  return String(result.stdout ?? '').trim();
}

function loadOpenAiKey(agenticmailConfigPath) {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  const cfg = readJson(agenticmailConfigPath, {});
  if (typeof cfg.openaiApiKey === 'string' && cfg.openaiApiKey.trim()) return cfg.openaiApiKey.trim();
  if (cfg.voiceProviderKeys && typeof cfg.voiceProviderKeys.openai === 'string') return cfg.voiceProviderKeys.openai.trim();
  return '';
}

function loadVoice(agenticmailConfigPath, pbxConfig) {
  const cfg = readJson(agenticmailConfigPath, {});
  const model = String(process.env.OPENAI_REALTIME_MODEL || pbxConfig.openaiModel || DEFAULT_MODEL).trim();
  const voice = String(
    process.env.OPENAI_REALTIME_VOICE
      || pbxConfig.openaiVoice
      || cfg.voiceProviderVoices?.openai
      || DEFAULT_VOICE,
  ).trim();
  return { model, voice };
}

function getLocalIpFor(remoteHost, remotePort) {
  const fallback = Object.values(os.networkInterfaces())
    .flat()
    .find((item) => item && item.family === 'IPv4' && !item.internal)?.address || '127.0.0.1';
  const socket = dgram.createSocket('udp4');
  try {
    socket.connect(remotePort, remoteHost);
    const address = socket.address();
    return address?.address || fallback;
  } catch {
    return fallback;
  } finally {
    try { socket.close(); } catch { /* ignore */ }
  }
}

function parseSipMessage(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const [head, ...bodyParts] = text.split(/\r?\n\r?\n/);
  const lines = head.split(/\r?\n/);
  const startLine = lines.shift() ?? '';
  const headers = new Map();
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!headers.has(name)) headers.set(name, []);
    headers.get(name).push(value);
  }
  return { raw: text, startLine, headers, body: bodyParts.join('\r\n\r\n') };
}

function header(msg, name) {
  const values = msg.headers.get(name.toLowerCase());
  return values?.[0] ?? '';
}

function allHeaders(msg, name) {
  return msg.headers.get(name.toLowerCase()) ?? [];
}

function methodOf(msg) {
  return msg.startLine.split(/\s+/)[0]?.toUpperCase() ?? '';
}

function statusCodeOf(msg) {
  const match = msg.startLine.match(/^SIP\/2\.0\s+(\d{3})/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function tagOf(value) {
  const match = value.match(/;\s*tag=([^;\s]+)/i);
  return match ? match[1] : '';
}

function branchOf(value) {
  const match = value.match(/;\s*branch=([^;\s]+)/i);
  return match ? match[1] : '';
}

function parseCseq(value) {
  const match = value.match(/^\s*(\d+)\s+([A-Z]+)/i);
  return { number: match ? Number.parseInt(match[1], 10) : 1, method: match ? match[2].toUpperCase() : '' };
}

function splitAddress(value) {
  const match = value.match(/<([^>]+)>/);
  return match ? match[1] : value.split(';')[0].trim();
}

function buildSipMessage(startLine, headers, body = '') {
  const lines = [startLine];
  for (const [name, value] of headers) {
    if (Array.isArray(value)) {
      for (const v of value) lines.push(`${name}: ${v}`);
    } else if (value !== undefined && value !== null && value !== '') {
      lines.push(`${name}: ${value}`);
    }
  }
  lines.push(`Content-Length: ${Buffer.byteLength(body, 'utf8')}`);
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

function responseTo(request, code, reason, extraHeaders = [], body = '') {
  const headers = [
    ...allHeaders(request, 'via').map((value) => ['Via', value]),
    ['From', header(request, 'from')],
    ['To', extraHeaders.find(([name]) => name.toLowerCase() === 'to')?.[1] ?? header(request, 'to')],
    ['Call-ID', header(request, 'call-id')],
    ['CSeq', header(request, 'cseq')],
    ...extraHeaders.filter(([name]) => name.toLowerCase() !== 'to'),
  ];
  return buildSipMessage(`SIP/2.0 ${code} ${reason}`, headers, body);
}

function parseDigestChallenge(value) {
  const text = value.replace(/^[^:]+:\s*/i, '').replace(/^Digest\s+/i, '');
  const out = {};
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let match;
  while ((match = re.exec(text))) {
    out[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return out;
}

function buildDigestAuth({ username, password, method, uri, challenge, nc = '00000001', cnonce = randomHex(8) }) {
  const realm = challenge.realm;
  const nonce = challenge.nonce;
  const qopList = String(challenge.qop || '').split(',').map((x) => x.trim()).filter(Boolean);
  const qop = qopList.includes('auth') ? 'auth' : '';
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `Digest username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    'algorithm=MD5',
  ];
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  return parts.join(', ');
}

function parseSdp(body) {
  const lines = String(body || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const connection = lines.find((line) => line.startsWith('c=IN IP4 '))?.slice('c=IN IP4 '.length) ?? '';
  const media = lines.find((line) => line.startsWith('m=audio ')) ?? '';
  const mediaParts = media.split(/\s+/);
  const port = Number.parseInt(mediaParts[1] ?? '', 10);
  const payloads = mediaParts.slice(3).map((x) => Number.parseInt(x, 10)).filter(Number.isFinite);
  return { connection, port, payloads };
}

function buildSdp({ localIp, rtpPort }) {
  return [
    'v=0',
    `o=agenticmail ${Date.now()} 1 IN IP4 ${localIp}`,
    's=AgenticMail SIP Sidecar',
    `c=IN IP4 ${localIp}`,
    't=0 0',
    `m=audio ${rtpPort} RTP/AVP 0`,
    'a=rtpmap:0 PCMU/8000',
    'a=ptime:20',
    'a=sendrecv',
  ].join('\r\n') + '\r\n';
}

function parseRtp(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const version = buffer[0] >> 6;
  if (version !== 2) return null;
  const csrcCount = buffer[0] & 0x0f;
  const extension = (buffer[0] & 0x10) !== 0;
  const marker = (buffer[1] & 0x80) !== 0;
  const payloadType = buffer[1] & 0x7f;
  const sequence = buffer.readUInt16BE(2);
  const timestamp = buffer.readUInt32BE(4);
  const ssrc = buffer.readUInt32BE(8);
  let offset = 12 + csrcCount * 4;
  if (extension) {
    if (buffer.length < offset + 4) return null;
    const extLengthWords = buffer.readUInt16BE(offset + 2);
    offset += 4 + extLengthWords * 4;
  }
  if (buffer.length < offset) return null;
  return { marker, payloadType, sequence, timestamp, ssrc, payload: buffer.subarray(offset) };
}

function buildRtp({ payload, payloadType = 0, sequence, timestamp, ssrc }) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = payloadType & 0x7f;
  header.writeUInt16BE(sequence & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

class OpenAiRealtimeBridge {
  constructor({ apiKey, model, voice, instructions, onAudio, onEvent, onClose }) {
    this.apiKey = apiKey;
    this.model = model;
    this.voice = voice;
    this.instructions = instructions;
    this.onAudio = onAudio;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.ws = null;
    this.ready = false;
    this.pendingAudio = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(this.model)}`;
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'OpenAI-Safety-Identifier': 'agenticmail-sip-sidecar-sales',
        },
      });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('OpenAI Realtime connection timed out')), 15000);
      ws.on('open', () => {
        clearTimeout(timer);
        this.ready = true;
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            model: this.model,
            output_modalities: ['audio'],
            instructions: this.instructions,
            audio: {
              input: {
                format: { type: 'audio/pcmu' },
                turn_detection: { type: 'server_vad' },
                transcription: { model: 'gpt-4o-mini-transcribe' },
              },
              output: {
                format: { type: 'audio/pcmu' },
                voice: this.voice,
              },
            },
          },
        }));
        ws.send(JSON.stringify({ type: 'response.create' }));
        for (const audio of this.pendingAudio.splice(0)) this.appendAudio(audio);
        resolve();
      });
      ws.on('message', (data) => this.handleMessage(data.toString()));
      ws.on('close', () => {
        this.ready = false;
        this.onClose?.();
      });
      ws.on('error', (err) => {
        this.onEvent?.({ type: 'openai_error', message: err.message });
      });
    });
  }

  appendAudio(payload) {
    if (!payload || payload.length === 0) return;
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.pendingAudio.length < 200) this.pendingAudio.push(Buffer.from(payload));
      return;
    }
    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: Buffer.from(payload).toString('base64'),
    }));
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'response.output_audio.delta' || msg.type === 'response.audio.delta') {
      if (typeof msg.delta === 'string' && msg.delta) {
        this.onAudio?.(Buffer.from(msg.delta, 'base64'));
      }
      return;
    }
    if (
      msg.type === 'conversation.item.input_audio_transcription.completed'
      || msg.type === 'response.output_audio_transcript.done'
      || msg.type === 'response.output_text.done'
      || msg.type === 'error'
    ) {
      this.onEvent?.({
        type: msg.type,
        text: msg.transcript || msg.text || msg.error?.message || '',
      });
    }
  }

  close() {
    try {
      if (this.ws) this.ws.close();
    } catch {
      // ignore
    }
  }
}

class RtpSession {
  constructor({ localIp, port, remoteIp, remotePort, onInboundAudio, onEnded }) {
    this.localIp = localIp;
    this.port = port;
    this.remoteIp = remoteIp;
    this.remotePort = remotePort;
    this.onInboundAudio = onInboundAudio;
    this.onEnded = onEnded;
    this.socket = dgram.createSocket('udp4');
    this.sequence = Math.floor(Math.random() * 65535);
    this.timestamp = Math.floor(Math.random() * 0xffffffff);
    this.ssrc = randomBytes(4).readUInt32BE(0);
    this.lastInboundAt = Date.now();
  }

  async start() {
    this.socket.on('message', (buf) => {
      const packet = parseRtp(buf);
      if (!packet) return;
      if (packet.payloadType !== 0) return;
      this.lastInboundAt = Date.now();
      this.onInboundAudio?.(packet.payload);
    });
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(this.port, this.localIp, () => {
        this.socket.off('error', reject);
        resolve();
      });
    });
  }

  sendAudio(buffer) {
    let offset = 0;
    while (offset < buffer.length) {
      const payload = buffer.subarray(offset, Math.min(buffer.length, offset + RTP_PACKET_BYTES));
      offset += payload.length;
      const packet = buildRtp({
        payload,
        payloadType: 0,
        sequence: this.sequence++,
        timestamp: this.timestamp,
        ssrc: this.ssrc,
      });
      this.timestamp = (this.timestamp + payload.length) >>> 0;
      this.socket.send(packet, this.remotePort, this.remoteIp);
    }
  }

  close() {
    try { this.socket.close(); } catch { /* ignore */ }
    this.onEnded?.();
  }
}

class SipCall {
  constructor({ id, direction, toNumber, task, sidecar }) {
    this.id = id;
    this.direction = direction;
    this.toNumber = toNumber;
    this.task = task;
    this.sidecar = sidecar;
    this.status = 'new';
    this.createdAt = nowIso();
    this.callId = `${randomHex(12)}@agenticmail`;
    this.localTag = randomHex(6);
    this.remoteTag = '';
    this.localRtpPort = 0;
    this.remoteRtpIp = '';
    this.remoteRtpPort = 0;
    this.rtp = null;
    this.openai = null;
    this.remoteTarget = '';
    this.remote = null;
    this.cseq = 1;
    this.lastInvite = null;
  }

  publicView() {
    return {
      id: this.id,
      direction: this.direction,
      status: this.status,
      toNumberRedacted: this.toNumber ? redactNumber(this.toNumber) : undefined,
      createdAt: this.createdAt,
      remoteRtp: this.remoteRtpIp && this.remoteRtpPort ? `${this.remoteRtpIp}:${this.remoteRtpPort}` : null,
    };
  }

  async startMedia() {
    if (!this.sidecar.openaiKey) {
      throw new Error('OPENAI_API_KEY is missing');
    }
    const { model, voice } = this.sidecar.voice;
    const instructions = this.sidecar.buildInstructions(this);
    this.rtp = new RtpSession({
      localIp: this.sidecar.localIp,
      port: this.localRtpPort,
      remoteIp: this.remoteRtpIp,
      remotePort: this.remoteRtpPort,
      onInboundAudio: (payload) => this.openai?.appendAudio(payload),
    });
    await this.rtp.start();
    this.openai = new OpenAiRealtimeBridge({
      apiKey: this.sidecar.openaiKey,
      model,
      voice,
      instructions,
      onAudio: (payload) => this.rtp?.sendAudio(payload),
      onEvent: (event) => this.sidecar.logEvent('call_event', { callId: this.id, ...event }),
      onClose: () => this.end('openai_closed'),
    });
    await this.openai.connect();
    this.status = 'media_active';
    this.sidecar.logEvent('call_media_active', { callId: this.id, direction: this.direction });
  }

  end(reason = 'ended') {
    if (this.status === 'ended') return;
    this.status = 'ended';
    try { this.openai?.close(); } catch { /* ignore */ }
    try { this.rtp?.close(); } catch { /* ignore */ }
    this.sidecar.logEvent('call_ended', { callId: this.id, reason });
  }
}

class SipSidecar {
  constructor({ configPath, agenticmailConfigPath }) {
    this.configPath = configPath;
    this.agenticmailConfigPath = agenticmailConfigPath;
    this.pbx = readJson(configPath, {});
    this.server = String(this.pbx.server || '').trim();
    this.port = asInt(this.pbx.port, 5060);
    this.username = String(this.pbx.username || '').trim();
    if (!this.server) throw new Error('PBX server is missing from the sidecar config');
    if (!this.username) throw new Error('PBX username is missing from the sidecar config');
    this.signalingPort = asInt(this.pbx.signalingPort, DEFAULT_SIP_PORT);
    this.rtpMin = asInt(this.pbx.rtpPortMin, DEFAULT_RTP_MIN);
    this.rtpMax = asInt(this.pbx.rtpPortMax, DEFAULT_RTP_MAX);
    this.httpPort = asInt(process.env.SIP_SIDECAR_HTTP_PORT || this.pbx.sidecarHttpPort, DEFAULT_HTTP_PORT);
    this.localIp = this.pbx.localIp || getLocalIpFor(this.server, this.port);
    this.secretPath = this.pbx.secretRef;
    this.password = '';
    this.openaiKey = '';
    this.voice = { model: DEFAULT_MODEL, voice: DEFAULT_VOICE };
    this.allowInbound = false;
    this.allowOutbound = false;
    this.socket = dgram.createSocket('udp4');
    this.httpServer = null;
    this.registered = false;
    this.lastRegister = null;
    this.lastRegisterError = null;
    this.calls = new Map();
    this.pendingTransactions = new Map();
    this.auditPath = this.pbx.auditPath || join(os.homedir(), '.agenticmail', 'sip-sidecar', 'events.jsonl');
    this.nextRtpPort = this.rtpMin % 2 === 0 ? this.rtpMin : this.rtpMin + 1;
    this.registerTimer = null;
    this.refreshRuntimeConfig();
  }

  refreshRuntimeConfig() {
    this.pbx = readJson(this.configPath, this.pbx);
    this.server = this.pbx.server || this.server;
    this.port = asInt(this.pbx.port, this.port);
    this.username = String(this.pbx.username || this.username);
    this.signalingPort = asInt(this.pbx.signalingPort, this.signalingPort);
    this.rtpMin = asInt(this.pbx.rtpPortMin, this.rtpMin);
    this.rtpMax = asInt(this.pbx.rtpPortMax, this.rtpMax);
    this.secretPath = this.pbx.secretRef || this.secretPath;
    this.password = loadDpapiSecret(this.secretPath);
    this.openaiKey = loadOpenAiKey(this.agenticmailConfigPath);
    this.voice = loadVoice(this.agenticmailConfigPath, this.pbx);
    this.allowInbound = this.pbx.liveAnswerEnabled === true || process.env.SIP_SIDECAR_ALLOW_INBOUND === 'true';
    this.allowOutbound = this.pbx.liveOutboundEnabled === true || process.env.SIP_SIDECAR_ALLOW_OUTBOUND === 'true';
    this.auditPath = this.pbx.auditPath || this.auditPath;
  }

  missing({ refresh = true } = {}) {
    if (refresh) this.refreshRuntimeConfig();
    const out = [];
    if (!existsSync(this.configPath)) out.push('pbx_config_missing');
    if (!this.password) out.push('pbx_secret_missing');
    if (!this.openaiKey) out.push('openai_api_key_missing');
    return out;
  }

  logEvent(type, payload = {}) {
    appendJsonl(this.auditPath, {
      at: nowIso(),
      type,
      ...payload,
    });
  }

  buildInstructions(call) {
    const task = call.task || this.pbx.defaultTask || [
      'You are the sales AI agent for the company.',
      'Answer naturally and briefly in Russian unless the caller uses another language.',
      'Your job is to qualify the caller, capture contact details, identify what they need, and agree on a safe next step.',
      'Do not make binding commercial promises, legal commitments, discounts, shipment promises, or payment commitments.',
      'If the caller asks for something you cannot verify, say you will clarify and follow up.',
    ].join(' ');
    return [
      `You are speaking on a live phone call through PBX extension ${this.username}.`,
      'Speak first with a short greeting. Keep turns concise and allow interruptions.',
      task,
    ].join('\n\n');
  }

  allocateRtpPort() {
    const port = this.nextRtpPort;
    this.nextRtpPort += 2;
    if (this.nextRtpPort > this.rtpMax) this.nextRtpPort = this.rtpMin % 2 === 0 ? this.rtpMin : this.rtpMin + 1;
    return port;
  }

  send(text, remote) {
    const buf = Buffer.from(text, 'utf8');
    this.socket.send(buf, remote.port, remote.address);
  }

  buildBaseHeaders({ method, uri, callId, fromTag, toUri, toTag, cseq, branch, contact = true }) {
    const local = `${this.localIp}:${this.signalingPort}`;
    const to = toTag ? `<${toUri}>;tag=${toTag}` : `<${toUri}>`;
    const headers = [
      ['Via', `SIP/2.0/UDP ${local};rport;branch=${branch || `z9hG4bK${randomHex(8)}`}`],
      ['Max-Forwards', '70'],
      ['From', `<sip:${this.username}@${this.server}>;tag=${fromTag}`],
      ['To', to],
      ['Call-ID', callId],
      ['CSeq', `${cseq} ${method}`],
    ];
    if (contact) headers.push(['Contact', `<sip:${this.username}@${local};transport=udp>`]);
    headers.push(['User-Agent', 'AgenticMail-SIP-Sidecar']);
    return { startLine: `${method} ${uri} SIP/2.0`, headers };
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(this.signalingPort, this.localIp, () => {
        this.socket.off('error', reject);
        resolve();
      });
    });
    this.socket.on('message', (buf, remote) => this.handleSip(buf, remote).catch((err) => {
      this.logEvent('sip_handler_error', { message: err.message });
    }));
    this.startHttp();
    this.logEvent('sidecar_started', {
      server: this.server,
      port: this.port,
      username: this.username,
      localIp: this.localIp,
      signalingPort: this.signalingPort,
    });
    await this.register().catch((err) => {
      this.lastRegisterError = err.message;
      this.logEvent('register_failed', { message: err.message });
    });
    this.registerTimer = setInterval(() => {
      this.register().catch((err) => {
        this.lastRegisterError = err.message;
        this.logEvent('register_failed', { message: err.message });
      });
    }, REGISTER_RENEW_SECONDS * 1000);
  }

  startHttp() {
    this.httpServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        this.sendJson(res, 200, this.health());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/calls/outbound') {
        this.readBody(req).then((body) => this.startOutbound(body)).then((call) => {
          this.sendJson(res, 202, { ok: true, call: call.publicView() });
        }).catch((err) => {
          this.sendJson(res, 400, { ok: false, error: err.message });
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/calls') {
        this.sendJson(res, 200, { calls: [...this.calls.values()].map((call) => call.publicView()) });
        return;
      }
      this.sendJson(res, 404, { error: 'not_found' });
    });
    this.httpServer.listen(this.httpPort, '127.0.0.1');
  }

  sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body, null, 2));
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 16 * 1024) reject(new Error('request body too large'));
      });
      req.on('end', () => {
        if (!data.trim()) return resolve({});
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
      req.on('error', reject);
    });
  }

  health() {
    const missing = this.missing();
    return {
      status: missing.length === 0 && this.registered ? 'ok' : 'blocked',
      server: this.server,
      port: this.port,
      username: this.username,
      localIp: this.localIp,
      signalingPort: this.signalingPort,
      registered: this.registered,
      lastRegister: this.lastRegister,
      lastRegisterError: this.lastRegisterError,
      openaiApiKeyPresent: Boolean(this.openaiKey),
      secretPresent: Boolean(this.password),
      allowInbound: this.allowInbound,
      allowOutbound: this.allowOutbound,
      activeCalls: [...this.calls.values()].filter((call) => call.status !== 'ended').length,
      missing,
    };
  }

  async register() {
    this.refreshRuntimeConfig();
    if (!this.password) throw new Error('PBX secret is missing');
    const callId = `${randomHex(12)}@agenticmail-register`;
    const fromTag = randomHex(6);
    const uri = `sip:${this.server}`;
    const make = (cseq, auth = '') => {
      const local = `${this.localIp}:${this.signalingPort}`;
      const headers = [
        ['Via', `SIP/2.0/UDP ${local};rport;branch=z9hG4bK${randomHex(8)}`],
        ['Max-Forwards', '70'],
        ['From', `<sip:${this.username}@${this.server}>;tag=${fromTag}`],
        ['To', `<sip:${this.username}@${this.server}>`],
        ['Call-ID', callId],
        ['CSeq', `${cseq} REGISTER`],
        ['Contact', `<sip:${this.username}@${local};transport=udp>`],
        ['Expires', String(REGISTER_EXPIRES_SECONDS)],
        ['User-Agent', 'AgenticMail-SIP-Sidecar'],
      ];
      if (auth) headers.push(['Authorization', auth]);
      return buildSipMessage(`REGISTER ${uri} SIP/2.0`, headers);
    };
    const first = await this.sendTransaction(make(1), { address: this.server, port: this.port }, callId, 'REGISTER', 1);
    const firstCode = statusCodeOf(first);
    if (firstCode === 200) return this.markRegistered();
    if (![401, 407].includes(firstCode)) throw new Error(`REGISTER failed: ${first.startLine}`);
    const challengeHeader = header(first, 'www-authenticate') || header(first, 'proxy-authenticate');
    const challenge = parseDigestChallenge(challengeHeader);
    const auth = buildDigestAuth({
      username: this.username,
      password: this.password,
      method: 'REGISTER',
      uri,
      challenge,
    });
    const second = await this.sendTransaction(make(2, auth), { address: this.server, port: this.port }, callId, 'REGISTER', 2);
    const secondCode = statusCodeOf(second);
    if (secondCode !== 200) throw new Error(`REGISTER failed: ${second.startLine}`);
    this.markRegistered();
  }

  markRegistered() {
    this.registered = true;
    this.lastRegister = nowIso();
    this.lastRegisterError = null;
    this.logEvent('registered', { server: this.server, username: this.username });
  }

  sendTransaction(text, remote, callId, method, cseq, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const key = `${callId}:${method}:${cseq}`;
      const timer = setTimeout(() => {
        this.pendingTransactions.delete(key);
        reject(new Error(`${method} transaction timed out`));
      }, timeoutMs);
      this.pendingTransactions.set(key, { resolve, timer });
      this.send(text, remote);
    });
  }

  async handleSip(buf, remote) {
    const msg = parseSipMessage(buf);
    const code = statusCodeOf(msg);
    if (code) {
      this.handleResponse(msg);
      return;
    }
    const method = methodOf(msg);
    if (method === 'INVITE') {
      await this.handleInvite(msg, remote);
      return;
    }
    if (method === 'ACK') return;
    if (method === 'BYE') {
      const call = [...this.calls.values()].find((item) => item.callId === header(msg, 'call-id'));
      if (call) call.end('remote_bye');
      this.send(responseTo(msg, 200, 'OK'), remote);
      return;
    }
    if (method === 'OPTIONS') {
      this.send(responseTo(msg, 200, 'OK', [['Allow', 'INVITE, ACK, BYE, CANCEL, OPTIONS']]), remote);
      return;
    }
    if (method === 'CANCEL') {
      this.send(responseTo(msg, 200, 'OK'), remote);
      return;
    }
    this.send(responseTo(msg, 405, 'Method Not Allowed', [['Allow', 'INVITE, ACK, BYE, CANCEL, OPTIONS']]), remote);
  }

  handleResponse(msg) {
    const callId = header(msg, 'call-id');
    const cseq = parseCseq(header(msg, 'cseq'));
    const key = `${callId}:${cseq.method}:${cseq.number}`;
    const tx = this.pendingTransactions.get(key);
    const code = statusCodeOf(msg);
    if (tx && code > 0 && code < 200) {
      this.logEvent('sip_provisional', { callId, method: cseq.method, code });
      return;
    }
    if (tx && code >= 200) {
      clearTimeout(tx.timer);
      this.pendingTransactions.delete(key);
      tx.resolve(msg);
    }
  }

  async handleInvite(msg, remote) {
    if (!this.allowInbound) {
      this.send(responseTo(msg, 486, 'Busy Here'), remote);
      return;
    }
    if (this.missing().length > 0) {
      this.send(responseTo(msg, 480, 'Temporarily Unavailable'), remote);
      return;
    }
    const sdp = parseSdp(msg.body);
    if (!sdp.connection || !sdp.port || !sdp.payloads.includes(0)) {
      this.send(responseTo(msg, 488, 'Not Acceptable Here'), remote);
      return;
    }
    this.send(responseTo(msg, 100, 'Trying'), remote);
    this.send(responseTo(msg, 180, 'Ringing'), remote);
    const call = new SipCall({
      id: `sip_${Date.now()}_${randomHex(4)}`,
      direction: 'inbound',
      sidecar: this,
    });
    call.callId = header(msg, 'call-id');
    call.remote = remote;
    call.remoteTarget = splitAddress(header(msg, 'contact')) || splitAddress(header(msg, 'from'));
    call.remoteTag = tagOf(header(msg, 'from'));
    call.localRtpPort = this.allocateRtpPort();
    call.remoteRtpIp = sdp.connection;
    call.remoteRtpPort = sdp.port;
    this.calls.set(call.id, call);
    const localTo = `${header(msg, 'to')};tag=${call.localTag}`;
    const answerSdp = buildSdp({ localIp: this.localIp, rtpPort: call.localRtpPort });
    this.send(responseTo(msg, 200, 'OK', [
      ['To', localTo],
      ['Contact', `<sip:${this.username}@${this.localIp}:${this.signalingPort};transport=udp>`],
      ['Content-Type', 'application/sdp'],
    ], answerSdp), remote);
    this.logEvent('inbound_invite_answered', { callId: call.id });
    try {
      await call.startMedia();
    } catch (err) {
      this.logEvent('call_media_failed', { callId: call.id, message: err.message });
      call.end('media_failed');
    }
  }

  async startOutbound(body) {
    if (!this.allowOutbound) throw new Error('outbound calls are disabled in PBX profile');
    if (this.missing().length > 0) throw new Error(`not ready: ${this.missing().join(', ')}`);
    const to = String(body.to || '').trim();
    if (!to) throw new Error('to is required');
    if (!/^[+0-9*#]{2,32}$/.test(to)) throw new Error('to must be a dialable phone/extension string');
    const call = new SipCall({
      id: `sip_${Date.now()}_${randomHex(4)}`,
      direction: 'outbound',
      toNumber: to,
      task: typeof body.task === 'string' ? body.task.slice(0, 2000) : '',
      sidecar: this,
    });
    call.localRtpPort = this.allocateRtpPort();
    this.calls.set(call.id, call);
    try {
      await this.sendInvite(call);
      return call;
    } catch (err) {
      this.logEvent('call_outbound_failed', { callId: call.id, message: err.message });
      call.end('dial_failed');
      throw err;
    }
  }

  async sendInvite(call) {
    const uri = `sip:${call.toNumber}@${this.server}`;
    const sdp = buildSdp({ localIp: this.localIp, rtpPort: call.localRtpPort });
    const makeInvite = (cseq, auth = '') => {
      const { startLine, headers } = this.buildBaseHeaders({
        method: 'INVITE',
        uri,
        callId: call.callId,
        fromTag: call.localTag,
        toUri: uri,
        cseq,
      });
      headers.push(['Content-Type', 'application/sdp']);
      if (auth) headers.push(['Authorization', auth]);
      return buildSipMessage(startLine, headers, sdp);
    };
    let response = await this.sendTransaction(makeInvite(1), { address: this.server, port: this.port }, call.callId, 'INVITE', 1, 15000);
    let code = statusCodeOf(response);
    if ([401, 407].includes(code)) {
      const challengeHeader = header(response, 'www-authenticate') || header(response, 'proxy-authenticate');
      const challenge = parseDigestChallenge(challengeHeader);
      const auth = buildDigestAuth({
        username: this.username,
        password: this.password,
        method: 'INVITE',
        uri,
        challenge,
      });
      response = await this.sendTransaction(makeInvite(2, auth), { address: this.server, port: this.port }, call.callId, 'INVITE', 2, 60000);
      code = statusCodeOf(response);
    }
    if (code !== 200) throw new Error(`INVITE failed: ${response.startLine}`);
    const answer = parseSdp(response.body);
    if (!answer.connection || !answer.port || !answer.payloads.includes(0)) throw new Error('remote answer did not accept PCMU');
    call.remoteRtpIp = answer.connection;
    call.remoteRtpPort = answer.port;
    call.remoteTag = tagOf(header(response, 'to'));
    call.remoteTarget = splitAddress(header(response, 'contact')) || uri;
    const ack = this.buildAck(call, uri);
    this.send(ack, { address: this.server, port: this.port });
    await call.startMedia();
  }

  buildAck(call, uri) {
    const local = `${this.localIp}:${this.signalingPort}`;
    const headers = [
      ['Via', `SIP/2.0/UDP ${local};rport;branch=z9hG4bK${randomHex(8)}`],
      ['Max-Forwards', '70'],
      ['From', `<sip:${this.username}@${this.server}>;tag=${call.localTag}`],
      ['To', `<${uri}>;tag=${call.remoteTag}`],
      ['Call-ID', call.callId],
      ['CSeq', '2 ACK'],
      ['Contact', `<sip:${this.username}@${local};transport=udp>`],
      ['User-Agent', 'AgenticMail-SIP-Sidecar'],
    ];
    return buildSipMessage(`ACK ${uri} SIP/2.0`, headers);
  }
}

const args = parseArgs(process.argv.slice(2));
const configPath = args.config || process.env.PBX199_CONFIG_PATH || DEFAULT_CONFIG_PATH;
const agenticmailConfigPath = args.agenticmailConfig || process.env.AGENTICMAIL_CONFIG_PATH || DEFAULT_AGENTICMAIL_CONFIG_PATH;
const sidecar = new SipSidecar({ configPath, agenticmailConfigPath });

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

sidecar.start().catch((err) => {
  console.error(`[sip-sidecar] failed to start: ${err.message}`);
  process.exit(1);
});
