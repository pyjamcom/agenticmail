/**
 * Realtime transport adapter — the provider-pluggable seam of the
 * realtime voice bridge.
 *
 * `RealtimeVoiceBridge` is transport-agnostic on the *socket* side
 * (it only ever sees abstract {@link RealtimeBridgePort}s), but the
 * *messages* on the carrier side are provider-specific: 46elks speaks
 * `hello`/`audio`/`bye` JSON over linear PCM, while Twilio Media Streams
 * speaks `connected`/`start`/`media`/`stop` JSON over G.711 µ-law.
 *
 * A {@link RealtimeTransportAdapter} captures exactly those differences:
 *   - how to interpret one inbound carrier frame ({@link parseInbound}),
 *   - how to build the outbound control frames (handshake / audio /
 *     interrupt / bye),
 *   - and which OpenAI Realtime audio format the carrier's audio needs.
 *
 * Everything else — the OpenAI session lifecycle, function calling,
 * barge-in handling, transcript accumulation, teardown — is identical
 * across providers and lives once in the bridge. This is the
 * "generalise the bridge" design: one bridge, one OpenAI side, a thin
 * per-provider adapter, no duplicated conversation logic.
 *
 * Adapters are pure (no sockets, no I/O), so the bridge stays fully
 * unit-testable and `@agenticmail/core` stays dependency-light.
 */

import {
  buildElksAudioMessage,
  buildElksByeMessage,
  buildElksHandshakeMessages,
  buildElksInterruptMessage,
  parseElksRealtimeMessage,
  type ElksRealtimeAudioFormat,
} from './realtime.js';
import {
  buildTwilioClearMessage,
  buildTwilioMediaMessage,
  parseTwilioRealtimeMessage,
} from './twilio-realtime.js';

/** Provider identifier — kept in lockstep with `PhoneTransportProvider`. */
export type RealtimeTransportProvider = '46elks' | 'twilio';

/**
 * A normalised inbound carrier event. Provider message shapes are
 * collapsed into this small, bridge-facing vocabulary so the bridge
 * never has to branch on the provider:
 *   - `hello`    — the call leg is live; carries the provider call id.
 *                  (46elks `hello`; Twilio `start`. Twilio's `connected`
 *                  frame is internal handshake noise → `ignore`.)
 *   - `audio`    — one inbound audio frame (base64), to relay to OpenAI.
 *   - `bye`      — the caller side ended the call.
 *   - `ignore`   — a known-but-uninteresting frame (e.g. Twilio `mark`).
 */
export type RealtimeInboundEvent =
  | { kind: 'hello'; callId: string; from?: string; to?: string }
  | { kind: 'audio'; data: string }
  | { kind: 'bye'; reason?: string; message?: string }
  | { kind: 'ignore' };

/**
 * The provider-specific seam the bridge drives. One instance per call.
 * Adapters that need per-call state (Twilio's `streamSid`) are
 * stateful — {@link parseInbound} latches that state from the `hello`
 * frame and the outbound builders read it back.
 */
export interface RealtimeTransportAdapter {
  /** Provider this adapter speaks for — used only for log/transcript text. */
  readonly provider: RealtimeTransportProvider;

  /**
   * Prefix for the carrier-side `onEnd` reason strings (`<prefix>-bye`,
   * `<prefix>-closed`, `<prefix>-error`). The 46elks adapter keeps the
   * historical `elks` prefix so existing call sites + tests that match
   * on `elks-bye` / `elks-closed` stay correct; Twilio uses `twilio`.
   */
  readonly endReasonPrefix: string;

  /**
   * The OpenAI Realtime audio format the carrier's audio requires.
   * 46elks linear PCM → `audio/pcm` @ 24 kHz; Twilio G.711 µ-law →
   * `audio/pcmu` @ 8 kHz. Used by `buildRealtimeSessionConfig` so the
   * OpenAI session in/out format matches the carrier with no transcode.
   */
  readonly openaiAudioFormat: { type: string; rate?: number };

  /**
   * Normalise one raw inbound carrier frame. Throws on a malformed
   * frame (the bridge catches the throw and ignores that frame). A
   * well-formed but uninteresting frame returns `{ kind: 'ignore' }`.
   */
  parseInbound(raw: string | Record<string, unknown>): RealtimeInboundEvent;

  /**
   * Frames to send the carrier the moment the call leg is live (right
   * after the `hello` event). 46elks needs a `listening`+`sending`
   * format handshake; Twilio needs nothing, so this is `[]`.
   */
  buildHandshake(): Record<string, unknown>[];

  /** Build one outbound audio frame (synthesised agent speech, base64). */
  buildAudio(base64: string): Record<string, unknown>;

  /**
   * Build the barge-in frame — tells the carrier to drop buffered
   * playback so the agent stops mid-sentence. 46elks `interrupt`;
   * Twilio `clear`.
   */
  buildInterrupt(): Record<string, unknown>;

  /**
   * Build the end-of-call frame for the carrier, or `null` if the
   * carrier has none (Twilio has no client-initiated stream-stop frame;
   * the bridge just closes the socket).
   */
  buildBye(): Record<string, unknown> | null;
}

// ─── 46elks adapter ─────────────────────────────────────

/**
 * The 46elks realtime-media adapter — the original transport, behaviour
 * unchanged. Audio is linear PCM, so the OpenAI session uses
 * `audio/pcm` @ 24 kHz (matching 46elks `pcm_24000`).
 */
export class ElksRealtimeTransport implements RealtimeTransportAdapter {
  readonly provider = '46elks' as const;
  // Historical prefix — `elks-bye` / `elks-closed` etc. are matched by
  // long-standing call sites and tests; do not change.
  readonly endReasonPrefix = 'elks';
  // OpenAI rejects `format.rate` as an unknown parameter — `audio/pcm` is
  // implicitly 24 kHz mono PCM16 in the current Realtime API.
  readonly openaiAudioFormat = { type: 'audio/pcm' };

  constructor(
    private readonly listenFormat: ElksRealtimeAudioFormat = 'pcm_24000',
    private readonly sendFormat: ElksRealtimeAudioFormat = 'pcm_24000',
  ) {}

  parseInbound(raw: string | Record<string, unknown>): RealtimeInboundEvent {
    const msg = parseElksRealtimeMessage(raw);
    if (msg.t === 'hello') {
      return { kind: 'hello', callId: msg.callid, from: msg.from, to: msg.to };
    }
    if (msg.t === 'audio') {
      return { kind: 'audio', data: msg.data };
    }
    return { kind: 'bye', reason: msg.reason, message: msg.message };
  }

  buildHandshake(): Record<string, unknown>[] {
    return buildElksHandshakeMessages({
      listenFormat: this.listenFormat,
      sendFormat: this.sendFormat,
    }) as unknown as Record<string, unknown>[];
  }

  buildAudio(base64: string): Record<string, unknown> {
    return buildElksAudioMessage(base64) as unknown as Record<string, unknown>;
  }

  buildInterrupt(): Record<string, unknown> {
    return buildElksInterruptMessage() as unknown as Record<string, unknown>;
  }

  buildBye(): Record<string, unknown> {
    return buildElksByeMessage() as unknown as Record<string, unknown>;
  }
}

// ─── Twilio adapter ─────────────────────────────────────

/**
 * The Twilio Media Streams adapter. Audio is G.711 µ-law @ 8 kHz, which
 * the OpenAI GA Realtime API speaks natively (`audio/pcmu`) — so the
 * bridge does NO transcoding for a Twilio call.
 *
 * Stateful per call: Twilio assigns a `streamSid` in the `start` frame
 * that EVERY outbound frame must echo. {@link parseInbound} latches it
 * on `start`; the outbound builders read it back. Building an outbound
 * frame before `start` throws — but the bridge never does that (it only
 * sends audio after the `hello` event, which `start` produces).
 */
export class TwilioRealtimeTransport implements RealtimeTransportAdapter {
  readonly provider = 'twilio' as const;
  readonly endReasonPrefix = 'twilio';
  // µ-law @ 8 kHz — Twilio's native format; no transcode end to end.
  // OpenAI rejects `format.rate` as an unknown parameter; `audio/pcmu` is
  // implicitly 8 kHz G.711 µ-law in the current Realtime API.
  readonly openaiAudioFormat = { type: 'audio/pcmu' };

  /** Latched from the Twilio `start` frame; required on every outbound. */
  private streamSid = '';

  /** The active `streamSid`, once the `start` frame has been seen. */
  get currentStreamSid(): string {
    return this.streamSid;
  }

  parseInbound(raw: string | Record<string, unknown>): RealtimeInboundEvent {
    const msg = parseTwilioRealtimeMessage(raw);
    switch (msg.event) {
      case 'connected':
        // Handshake noise — the real "call is live" signal is `start`.
        return { kind: 'ignore' };
      case 'start':
        // Latch the streamSid every outbound frame must carry. The
        // callSid is the bridge-facing "call id" used to resolve the
        // phone mission, exactly as the 46elks `callid` is.
        this.streamSid = msg.streamSid;
        return { kind: 'hello', callId: msg.callSid };
      case 'media':
        return { kind: 'audio', data: msg.payload };
      case 'stop':
        return { kind: 'bye', reason: 'twilio-stream-stopped' };
      case 'mark':
        // Playback checkpoint echo — not acted on by the bridge.
        return { kind: 'ignore' };
      default:
        return { kind: 'ignore' };
    }
  }

  buildHandshake(): Record<string, unknown>[] {
    // Twilio Media Streams has no client→server handshake — the server
    // just starts sending `media` frames once `start` has arrived.
    return [];
  }

  buildAudio(base64: string): Record<string, unknown> {
    return buildTwilioMediaMessage(this.streamSid, base64) as unknown as Record<string, unknown>;
  }

  buildInterrupt(): Record<string, unknown> {
    // Twilio's barge-in primitive: `clear` flushes buffered playback.
    return buildTwilioClearMessage(this.streamSid) as unknown as Record<string, unknown>;
  }

  buildBye(): Record<string, unknown> | null {
    // No client-initiated stop frame in the Media Streams protocol —
    // the bridge ends the call by closing the WebSocket.
    return null;
  }
}

/** Construct the transport adapter for a provider. */
export function createRealtimeTransport(
  provider: RealtimeTransportProvider,
): RealtimeTransportAdapter {
  return provider === 'twilio' ? new TwilioRealtimeTransport() : new ElksRealtimeTransport();
}
