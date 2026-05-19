/**
 * Twilio Media Streams wire protocol.
 *
 * The realtime-voice counterpart of `realtime.ts` (the 46elks protocol).
 * Twilio connects a call's audio to a WebSocket via a TwiML
 * `<Connect><Stream url="wss://…"/></Connect>`; over that socket Twilio
 * speaks JSON messages keyed by an `event` field.
 *
 * Inbound (Twilio → us):
 *   - `{ event: "connected", protocol, version }`
 *   - `{ event: "start", start: { streamSid, callSid, accountSid,
 *                                 mediaFormat, tracks, customParameters } }`
 *   - `{ event: "media", media: { payload: "<base64 µ-law>", track,
 *                                 chunk, timestamp } }`
 *   - `{ event: "stop", stop: { accountSid, callSid } }`
 *   - `{ event: "mark", mark: { name } }`
 *
 * Outbound (us → Twilio) — every outbound frame must echo the
 * `streamSid` Twilio handed us in the `start` event:
 *   - `{ event: "media", streamSid, media: { payload: "<base64 µ-law>" } }`
 *   - `{ event: "mark", streamSid, mark: { name } }`
 *   - `{ event: "clear", streamSid }`  — flush buffered playback
 *     (barge-in / interrupt; the analogue of 46elks `interrupt`).
 *
 * The audio is G.711 µ-law, 8 kHz, mono, base64 — unlike 46elks which
 * uses linear PCM. OpenAI's GA Realtime API speaks µ-law natively
 * (`{ type: "audio/pcmu" }` @ 8 kHz), so on a Twilio call the bridge
 * does NO transcoding end to end.
 *
 * > The Media Streams message shapes above follow Twilio's public
 * > `<Stream>` documentation. Verify against current docs before the
 * > live smoke-test (same discipline as the 46elks / OpenAI wire notes).
 */

/** µ-law payload sample rate Twilio Media Streams uses, in Hz. */
export const TWILIO_MEDIA_SAMPLE_RATE = 8_000;

/** The `connected` handshake frame — first frame Twilio sends. */
export interface TwilioConnectedMessage {
  event: 'connected';
  protocol?: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * The `start` frame — carries the `streamSid` every outbound frame must
 * echo, plus the `callSid` we resolve the phone mission from. Twilio
 * sends exactly one `start` per stream, right after `connected`.
 */
export interface TwilioStartMessage {
  event: 'start';
  /** Stream identifier — required on every outbound media/mark/clear. */
  streamSid: string;
  /** The call SID — matches the `sid` from the Calls.json response. */
  callSid: string;
  accountSid?: string;
  mediaFormat?: { encoding?: string; sampleRate?: number; channels?: number };
  tracks?: string[];
  /** `<Parameter>` values declared inside the TwiML `<Stream>`. */
  customParameters?: Record<string, string>;
  [key: string]: unknown;
}

/** A `media` frame — one small base64 µ-law audio chunk. */
export interface TwilioMediaMessage {
  event: 'media';
  /** Base64-encoded G.711 µ-law, 8 kHz mono. */
  payload: string;
  /** Inbound only: which leg the audio is from (`inbound`/`outbound`). */
  track?: string;
}

/** The `stop` frame — Twilio has stopped streaming this call's audio. */
export interface TwilioStopMessage {
  event: 'stop';
  callSid?: string;
  [key: string]: unknown;
}

/** A `mark` frame — a playback checkpoint echoed back when reached. */
export interface TwilioMarkMessage {
  event: 'mark';
  name: string;
}

export type TwilioRealtimeInboundMessage =
  | TwilioConnectedMessage
  | TwilioStartMessage
  | TwilioMediaMessage
  | TwilioStopMessage
  | TwilioMarkMessage;

export type TwilioRealtimeOutboundMessage =
  | { event: 'media'; streamSid: string; media: { payload: string } }
  | { event: 'mark'; streamSid: string; mark: { name: string } }
  | { event: 'clear'; streamSid: string };

function asRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A relaxed base64 test — mirrors `realtime.ts`'s `looksLikeBase64`.
 * Twilio µ-law payloads are always a multiple of 4 base64 chars.
 */
function looksLikeBase64(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

function decodeJsonMessage(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      return asRecord(JSON.parse(input));
    } catch {
      throw new Error('Invalid Twilio media-stream message: expected JSON object string');
    }
  }
  return asRecord(input);
}

/**
 * Parse one raw inbound Twilio Media Streams frame. Accepts a JSON
 * string or an already-parsed object. Throws on a malformed/unknown
 * frame — the caller (the bridge) swallows the throw and ignores the
 * frame, never tearing the call down for one bad message.
 */
export function parseTwilioRealtimeMessage(input: unknown): TwilioRealtimeInboundMessage {
  const msg = decodeJsonMessage(input);
  const event = asString(msg.event);

  if (event === 'connected') {
    return { ...msg, event: 'connected' } as TwilioConnectedMessage;
  }

  if (event === 'start') {
    // The `start` payload is nested under `start`; Twilio echoes
    // `streamSid` at the top level too. Accept either, prefer nested.
    const start = asRecord(msg.start);
    const streamSid = asString(start.streamSid) || asString(msg.streamSid);
    const callSid = asString(start.callSid);
    if (!streamSid || !callSid) {
      throw new Error('Invalid Twilio start message: streamSid and callSid are required');
    }
    const customParameters = asRecord(start.customParameters);
    return {
      ...msg,
      event: 'start',
      streamSid,
      callSid,
      accountSid: asString(start.accountSid) || undefined,
      mediaFormat: asRecord(start.mediaFormat) as TwilioStartMessage['mediaFormat'],
      tracks: Array.isArray(start.tracks)
        ? start.tracks.filter((t): t is string => typeof t === 'string')
        : undefined,
      customParameters: Object.keys(customParameters).length
        ? Object.fromEntries(
            Object.entries(customParameters).map(([k, v]) => [k, String(v)]),
          )
        : undefined,
    } as TwilioStartMessage;
  }

  if (event === 'media') {
    const media = asRecord(msg.media);
    const payload = asString(media.payload);
    if (!looksLikeBase64(payload)) {
      throw new Error('Invalid Twilio media message: payload must be non-empty base64');
    }
    return { event: 'media', payload, track: asString(media.track) || undefined };
  }

  if (event === 'stop') {
    const stop = asRecord(msg.stop);
    return { ...msg, event: 'stop', callSid: asString(stop.callSid) || undefined } as TwilioStopMessage;
  }

  if (event === 'mark') {
    const mark = asRecord(msg.mark);
    return { event: 'mark', name: asString(mark.name) };
  }

  throw new Error(`Unsupported Twilio media-stream event: ${event || '(missing)'}`);
}

/**
 * Build an outbound `media` frame — synthesised agent audio for Twilio
 * to play to the caller. `data` may be a base64 string or raw bytes.
 * `streamSid` is the id Twilio handed us in the `start` event.
 */
export function buildTwilioMediaMessage(
  streamSid: string,
  data: string | Uint8Array,
): TwilioRealtimeOutboundMessage {
  if (!streamSid) throw new Error('Twilio media message requires a streamSid');
  const payload = typeof data === 'string' ? data : Buffer.from(data).toString('base64');
  if (!looksLikeBase64(payload)) {
    throw new Error('Twilio media payload must be base64 or bytes');
  }
  return { event: 'media', streamSid, media: { payload } };
}

/**
 * Build a `clear` frame — tells Twilio to flush any audio still
 * buffered for playback. This is how barge-in / interrupt works on a
 * Twilio call: when the caller starts talking the agent must stop
 * mid-sentence, so we drop everything queued. (46elks calls this
 * `interrupt`; Twilio calls it `clear`.)
 */
export function buildTwilioClearMessage(streamSid: string): TwilioRealtimeOutboundMessage {
  if (!streamSid) throw new Error('Twilio clear message requires a streamSid');
  return { event: 'clear', streamSid };
}

/**
 * Build a `mark` frame — a named playback checkpoint. Twilio echoes the
 * mark back (as an inbound `mark` event) once the audio queued before
 * it has actually been played to the caller. Useful for end-of-turn
 * detection; the bridge does not require it but exposes the builder for
 * parity with the protocol surface.
 */
export function buildTwilioMarkMessage(
  streamSid: string,
  name: string,
): TwilioRealtimeOutboundMessage {
  if (!streamSid) throw new Error('Twilio mark message requires a streamSid');
  return { event: 'mark', streamSid, mark: { name } };
}
