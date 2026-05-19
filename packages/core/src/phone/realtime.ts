export const ELKS_REALTIME_AUDIO_FORMATS = ['ulaw', 'pcm_16000', 'pcm_24000', 'wav'] as const;
export type ElksRealtimeAudioFormat = typeof ELKS_REALTIME_AUDIO_FORMATS[number];

export interface ElksRealtimeHelloMessage {
  t: 'hello';
  callid: string;
  from: string;
  to: string;
  [key: string]: unknown;
}

export interface ElksRealtimeAudioMessage {
  t: 'audio';
  data: string;
}

export interface ElksRealtimeByeMessage {
  t: 'bye';
  reason?: string;
  message?: string;
  [key: string]: unknown;
}

export type ElksRealtimeInboundMessage =
  | ElksRealtimeHelloMessage
  | ElksRealtimeAudioMessage
  | ElksRealtimeByeMessage;

export type ElksRealtimeOutboundMessage =
  | { t: 'listening'; format: ElksRealtimeAudioFormat }
  | { t: 'sending'; format: ElksRealtimeAudioFormat }
  | { t: 'audio'; data: string }
  | { t: 'interrupt' }
  | { t: 'bye' };

function asRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isAudioFormat(value: unknown): value is ElksRealtimeAudioFormat {
  return typeof value === 'string' && (ELKS_REALTIME_AUDIO_FORMATS as readonly string[]).includes(value);
}

function assertAudioFormat(format: ElksRealtimeAudioFormat): ElksRealtimeAudioFormat {
  if (!isAudioFormat(format)) {
    throw new Error(`Unsupported 46elks realtime audio format: ${String(format)}`);
  }
  return format;
}

function looksLikeBase64(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

function decodeJsonMessage(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      return asRecord(JSON.parse(input));
    } catch {
      throw new Error('Invalid 46elks realtime message: expected JSON object string');
    }
  }
  return asRecord(input);
}

export function parseElksRealtimeMessage(input: unknown): ElksRealtimeInboundMessage {
  const msg = decodeJsonMessage(input);
  const type = asString(msg.t);

  if (type === 'hello') {
    const callid = asString(msg.callid);
    const from = asString(msg.from);
    const to = asString(msg.to);
    if (!callid || !from || !to) {
      throw new Error('Invalid 46elks realtime hello: callid, from, and to are required');
    }
    return { ...msg, t: 'hello', callid, from, to } as ElksRealtimeHelloMessage;
  }

  if (type === 'audio') {
    const data = asString(msg.data);
    if (!looksLikeBase64(data)) {
      throw new Error('Invalid 46elks realtime audio: data must be non-empty base64');
    }
    return { t: 'audio', data };
  }

  if (type === 'bye') {
    const reason = asString(msg.reason) || undefined;
    const message = asString(msg.message) || undefined;
    return { ...msg, t: 'bye', reason, message } as ElksRealtimeByeMessage;
  }

  throw new Error(`Unsupported 46elks realtime message type: ${type || '(missing)'}`);
}

export function buildElksListeningMessage(format: ElksRealtimeAudioFormat = 'pcm_24000'): ElksRealtimeOutboundMessage {
  return { t: 'listening', format: assertAudioFormat(format) };
}

export function buildElksSendingMessage(format: ElksRealtimeAudioFormat = 'pcm_24000'): ElksRealtimeOutboundMessage {
  return { t: 'sending', format: assertAudioFormat(format) };
}

export function buildElksAudioMessage(data: string | Uint8Array): ElksRealtimeOutboundMessage {
  const encoded = typeof data === 'string' ? data : Buffer.from(data).toString('base64');
  if (!looksLikeBase64(encoded)) {
    throw new Error('46elks realtime audio data must be base64 or bytes');
  }
  return { t: 'audio', data: encoded };
}

export function buildElksInterruptMessage(): ElksRealtimeOutboundMessage {
  return { t: 'interrupt' };
}

export function buildElksByeMessage(): ElksRealtimeOutboundMessage {
  return { t: 'bye' };
}

export function buildElksHandshakeMessages(options: {
  listenFormat?: ElksRealtimeAudioFormat;
  sendFormat?: ElksRealtimeAudioFormat;
} = {}): ElksRealtimeOutboundMessage[] {
  return [
    buildElksListeningMessage(options.listenFormat ?? 'pcm_24000'),
    buildElksSendingMessage(options.sendFormat ?? 'pcm_24000'),
  ];
}
