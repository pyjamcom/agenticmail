/**
 * Realtime voice bridge — wires the OpenAI Realtime API to a phone
 * carrier's realtime-media WebSocket so a phone mission can actually
 * *converse*.
 *
 * # Shape of the integration
 *
 *   caller  ⇄  carrier  ⇄  (carrier media WebSocket)  ⇄  AgenticMail
 *                                                         │
 *                                          RealtimeVoiceBridge
 *                                                         │
 *                                      (OpenAI Realtime WebSocket)
 *                                                         │
 *                                                   gpt-realtime
 *
 * The carrier streams the live call audio to AgenticMail as JSON frames
 * (base64 audio); AgenticMail relays them to OpenAI as
 * `input_audio_buffer.append`; OpenAI streams synthesised speech back
 * as `response.output_audio.delta`; AgenticMail relays that to the
 * carrier. Server-side VAD on the OpenAI session handles turn-taking —
 * no manual commit / response.create.
 *
 * # Provider-pluggable transport
 *
 * The carrier side speaks a provider-specific wire protocol — 46elks
 * (`hello`/`audio`/`bye`, linear PCM) and Twilio Media Streams
 * (`connected`/`start`/`media`/`stop`, G.711 µ-law). Those differences
 * are isolated behind a {@link RealtimeTransportAdapter}: the bridge
 * itself — OpenAI session lifecycle, function calling, barge-in,
 * transcript, teardown — is identical across providers and lives here
 * once. The bridge defaults to the 46elks adapter, so existing callers
 * that pass no `transport` keep their exact prior behaviour.
 *
 * # Memory injection — the whole point
 *
 * Before the OpenAI session starts, the agent's persistent memory is
 * rendered (`AgentMemoryManager.generateMemoryContext()`) and folded
 * into the Realtime session `instructions`. The model is told to treat
 * that block as *its own* long-term knowledge — so on the call it acts
 * with full continuity, as if it had always known those things.
 *
 * # Why this file is transport-agnostic
 *
 * `RealtimeVoiceBridge` never touches a socket. It takes two abstract
 * {@link RealtimeBridgePort}s (one per side) and is driven by
 * `handle*Message` / `handle*Open` / `handle*Close` calls. The real
 * WebSocket plumbing lives in `@agenticmail/api` (which has the `ws`
 * dependency); tests drive the bridge with in-memory fake ports. This
 * keeps `@agenticmail/core` dependency-free and the bridge logic fully
 * unit-testable without a live OpenAI key or a carrier websocket number.
 *
 * The exact OpenAI Realtime wire shapes below are the GA `gpt-realtime`
 * protocol (session config nested under `audio.input` / `audio.output`,
 * `format` as an object, `response.output_audio.delta` for output). The
 * legacy beta output event name `response.audio.delta` is also handled
 * defensively — some `gpt-realtime` deployments still emit it.
 */

import type { ElksRealtimeAudioFormat } from './realtime.js';
import {
  ElksRealtimeTransport,
  type RealtimeTransportAdapter,
} from './realtime-transport.js';
import {
  buildRealtimeToolGuidance,
  type RealtimeToolCall,
  type RealtimeToolDefinition,
  type ToolExecutor,
} from './realtime-tools.js';

// ─── Constants ──────────────────────────────────────────

/** OpenAI Realtime WebSocket base URL (model passed as `?model=`). */
export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';
/** GA Realtime model. */
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime';
/** Default GA Realtime voice. */
export const DEFAULT_REALTIME_VOICE = 'marin';
/** PCM sample rate shared by 46elks `pcm_24000` and the OpenAI session. */
export const REALTIME_AUDIO_SAMPLE_RATE = 24_000;

/**
 * #46-H1 — hard ceiling on a single inbound audio frame, measured in
 * base64 characters. Realtime frames are tiny (20–100 ms of audio); a
 * frame larger than this is either a buggy or a hostile peer trying to
 * push an unbounded allocation through the bridge. Oversized frames are
 * dropped, never forwarded. ~256 KiB of base64 ≈ 4 s of 24 kHz PCM16 —
 * far above any legitimate realtime frame, so this never trims real
 * speech, it only fences off abuse.
 */
export const REALTIME_MAX_AUDIO_FRAME_BASE64 = 256 * 1024;

/**
 * Cap on audio frames buffered while the OpenAI socket is still
 * connecting. The pre-ready window is normally a few hundred ms; this
 * bounds memory if OpenAI is slow or never opens.
 */
const MAX_PENDING_AUDIO_FRAMES = 200;

/**
 * Bridge-side safety net for a slow tool call (plan §6). The model-side
 * keeps the line warm (it announces a hold and reassures the caller);
 * this is the floor under that — if a tool's `execute()` never settles
 * (a hung `ask_operator`, a wedged search) the bridge still answers the
 * model after this long so the call cannot be wedged forever. It is set
 * deliberately ABOVE `OPERATOR_QUERY_TIMEOUT_MS` (5 min) so the tool's
 * own graceful timeout sentinel normally wins the race; this only fires
 * if the executor itself hangs.
 */
export const REALTIME_TOOL_CALL_TIMEOUT_MS = 6 * 60_000;

/**
 * Hard ceiling on how many tool calls the bridge will track in flight
 * at once. The model rarely fans out more than one or two; a flood is
 * either a buggy or a hostile peer, so excess calls are answered with a
 * refusal rather than dispatched.
 */
const MAX_IN_FLIGHT_TOOL_CALLS = 8;

// ─── Session config ─────────────────────────────────────

export interface RealtimeInstructionOptions {
  /** The concrete objective of this call. */
  task: string;
  /** Rendered agent memory block (from `generateMemoryContext()`). */
  memoryContext?: string;
  /** The agent's display name, used in the persona line. */
  agentName?: string;
  /** Override the default persona preamble. */
  persona?: string;
  /**
   * Natural-language tool-use guidance, appended as its own section.
   * Normally produced by `buildRealtimeToolGuidance()` and folded in
   * automatically by `buildRealtimeSessionConfig()` when tools are set.
   */
  toolGuidance?: string;
}

const DEFAULT_PERSONA =
  'You are a helpful, professional voice assistant making a phone call on behalf of your operator. '
  + 'Speak naturally and concisely, the way a person would on a real call. Listen carefully, do not '
  + 'talk over the other party, and keep each turn short. Never invent facts; if you do not know '
  + 'something, say so. Do not reveal that you are an AI unless you are asked directly.';

/**
 * Compose the Realtime session `instructions` string. The agent's
 * memory is presented as the model's *own* knowledge — not as external
 * notes — so the call feels continuous with everything the agent has
 * learned elsewhere.
 */
export function buildRealtimeInstructions(opts: RealtimeInstructionOptions): string {
  const persona = opts.persona?.trim() || DEFAULT_PERSONA;
  const sections: string[] = [];

  sections.push(opts.agentName ? `${persona}\n\nYour name is ${opts.agentName}.` : persona);

  const task = opts.task?.trim();
  if (task) {
    sections.push(`# Your objective on this call\n${task}`);
  }

  const memory = opts.memoryContext?.trim();
  if (memory) {
    sections.push(
      '# What you already know\n'
      + 'The following is your own long-term memory — knowledge, preferences, and lessons you have '
      + 'accumulated over time. Treat it as your own experience and act on it naturally. Do not read '
      + 'it aloud or mention that it is "memory"; simply know it.\n\n'
      + memory,
    );
  }

  const toolGuidance = opts.toolGuidance?.trim();
  if (toolGuidance) {
    sections.push(toolGuidance);
  }

  return sections.join('\n\n');
}

export interface RealtimeSessionConfigOptions extends RealtimeInstructionOptions {
  /** OpenAI Realtime voice (default {@link DEFAULT_REALTIME_VOICE}). */
  voice?: string;
  /** OpenAI Realtime model (default {@link DEFAULT_REALTIME_MODEL}). */
  model?: string;
  /** Provide a fully-formed instruction string instead of composing one. */
  instructions?: string;
  /**
   * Function tools to declare on the session. When present they are
   * emitted under `session.tools` with a `tool_choice`, and (unless
   * `instructions` is overridden) tool-use guidance is folded into the
   * composed instructions automatically.
   */
  tools?: RealtimeToolDefinition[];
  /** `tool_choice` override — defaults to `'auto'` when tools are set. */
  toolChoice?: 'auto' | 'none' | 'required';
  /**
   * OpenAI Realtime audio format for the session's input AND output.
   * Defaults to linear PCM @ 24 kHz (`{ type: 'audio/pcm', rate: 24000 }`)
   * — the format a 46elks `pcm_24000` call needs. A Twilio call must
   * pass `{ type: 'audio/pcmu', rate: 8000 }` (G.711 µ-law @ 8 kHz) so
   * the OpenAI session speaks the carrier's native codec with NO
   * transcoding. Normally sourced from a {@link RealtimeTransportAdapter}'s
   * `openaiAudioFormat`.
   */
  audioFormat?: { type: string; rate?: number };
}

/** Default OpenAI Realtime audio format — linear PCM @ 24 kHz (46elks). */
export const DEFAULT_REALTIME_AUDIO_FORMAT = { type: 'audio/pcm', rate: REALTIME_AUDIO_SAMPLE_RATE } as const;

/**
 * Build the `session.update` client event for the GA `gpt-realtime`
 * API. Audio in/out default to PCM16 @ 24 kHz (matches 46elks
 * `pcm_24000`); a Twilio call passes `audioFormat: { type: 'audio/pcmu',
 * rate: 8000 }` so the session speaks G.711 µ-law natively. Turn-taking
 * is server-side VAD, and the agent's memory is folded into
 * `instructions`.
 *
 * When `tools` are supplied they are declared under `session.tools`
 * with a `tool_choice` (default `'auto'`), and — unless the caller
 * passed an explicit `instructions` string — natural-language tool-use
 * guidance is appended to the composed instructions so the model knows
 * to put the caller on hold before a slow tool (plan §6).
 *
 * > The `session.tools` / `tool_choice` field names follow the OpenAI
 * > Realtime function-calling protocol per the plan §3, and the
 * > `audio/pcmu` µ-law format token follows the OpenAI GA Realtime
 * > audio-format protocol; verify both against current OpenAI docs
 * > before the live smoke test.
 */
export function buildRealtimeSessionConfig(
  opts: RealtimeSessionConfigOptions,
): Record<string, unknown> {
  const tools = opts.tools ?? [];
  // Fold tool-use guidance into the composed instructions — but only
  // when we are composing them; an explicit `instructions` override is
  // taken verbatim, the caller owns it.
  const instructions = (opts.instructions?.trim())
    || buildRealtimeInstructions({
      ...opts,
      toolGuidance: opts.toolGuidance ?? buildRealtimeToolGuidance(tools),
    });

  // Audio format shared by the session's input + output. The carrier's
  // codec drives this: 46elks → linear PCM @ 24 kHz, Twilio → µ-law @
  // 8 kHz. Matching it end to end means the bridge never transcodes.
  const audioFormat = opts.audioFormat ?? DEFAULT_REALTIME_AUDIO_FORMAT;

  const session: Record<string, unknown> = {
    type: 'realtime',
    model: opts.model?.trim() || DEFAULT_REALTIME_MODEL,
    output_modalities: ['audio'],
    instructions,
    audio: {
      input: {
        format: { ...audioFormat },
        turn_detection: { type: 'server_vad' },
      },
      output: {
        format: { ...audioFormat },
        voice: opts.voice?.trim() || DEFAULT_REALTIME_VOICE,
      },
    },
  };

  if (tools.length > 0) {
    session.tools = tools;
    session.tool_choice = opts.toolChoice ?? 'auto';
  }

  return { type: 'session.update', session };
}

/** Build the `wss://…/v1/realtime?model=…` URL for a model. */
export function buildOpenAIRealtimeUrl(model: string = DEFAULT_REALTIME_MODEL): string {
  return `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(model || DEFAULT_REALTIME_MODEL)}`;
}

// ─── The bridge ─────────────────────────────────────────

/** One side of the bridge — a JSON message sink that can be closed. */
export interface RealtimeBridgePort {
  /** Send one JSON message to the peer. Must not throw. */
  send(message: Record<string, unknown>): void;
  /** Close the underlying connection. Must be idempotent. */
  close(): void;
}

export interface RealtimeBridgeTranscriptEntry {
  source: 'system' | 'provider' | 'agent';
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RealtimeVoiceBridgeOptions {
  /**
   * Port to the carrier realtime-media side. Named `elks` for backward
   * compatibility (it predates the Twilio transport); `carrier` is the
   * provider-neutral alias and takes precedence if both are given.
   */
  elks?: RealtimeBridgePort;
  /** Provider-neutral alias for {@link elks} — the carrier media port. */
  carrier?: RealtimeBridgePort;
  /** Port to the OpenAI Realtime side. */
  openai: RealtimeBridgePort;
  /** `session.update` payload — sent to OpenAI once its socket opens. */
  sessionConfig: Record<string, unknown>;
  /**
   * Carrier transport adapter — encodes/decodes the provider's wire
   * protocol (46elks vs Twilio Media Streams). Defaults to the 46elks
   * adapter, so callers that omit it keep the original behaviour.
   */
  transport?: RealtimeTransportAdapter;
  /**
   * 46elks-only: audio format we ask 46elks to send us (default
   * `pcm_24000`). Ignored unless the default 46elks transport is used
   * and no explicit `transport` was supplied.
   */
  listenFormat?: ElksRealtimeAudioFormat;
  /**
   * 46elks-only: audio format we declare for the audio we send 46elks
   * (default `pcm_24000`). Ignored unless the default 46elks transport
   * is used and no explicit `transport` was supplied.
   */
  sendFormat?: ElksRealtimeAudioFormat;
  /** Per-frame base64 ceiling (default {@link REALTIME_MAX_AUDIO_FRAME_BASE64}). */
  maxAudioFrameBase64?: number;
  /**
   * Dispatches the model's function calls. When omitted the bridge has
   * no tools — a function call from the model is acknowledged with a
   * "no tools available" output rather than left to wedge the model.
   */
  toolExecutor?: ToolExecutor;
  /**
   * Bridge-side safety-net timeout for a single tool call (default
   * {@link REALTIME_TOOL_CALL_TIMEOUT_MS}). If the executor does not
   * settle within this window the bridge answers the model itself so
   * the call cannot be wedged by a hung tool.
   */
  maxToolCallMs?: number;
  /** Sink for transcript / lifecycle entries worth persisting on the mission. */
  onTranscript?: (entry: RealtimeBridgeTranscriptEntry) => void;
  /**
   * Called exactly once when the bridge has fully ended. `pendingToolCalls`
   * is how many tool calls were still in flight at teardown — non-zero
   * means the call dropped mid-tool (e.g. an unanswered `ask_operator`),
   * which is the signal the API layer uses to arm callback-on-disconnect
   * (plan §7).
   */
  onEnd?: (summary: { reason: string; pendingToolCalls: number }) => void;
}

/**
 * Bridges a phone carrier's realtime-media connection to an OpenAI
 * Realtime connection. Provider-pluggable: the carrier wire protocol
 * (46elks vs Twilio Media Streams) is isolated in a
 * {@link RealtimeTransportAdapter}; the conversation logic here is
 * provider-neutral. The caller pumps raw messages in via
 * `handleCarrierMessage` / `handleOpenAIMessage` and connection
 * lifecycle via `handle*Open` / `handle*Close`. Every public method is
 * safe to call after the bridge has ended (they become no-ops).
 *
 * The legacy `handleElks*` method names remain as thin aliases for the
 * `handleCarrier*` methods so existing 46elks call sites and tests do
 * not break.
 */
export class RealtimeVoiceBridge {
  private readonly carrier: RealtimeBridgePort;
  private readonly openai: RealtimeBridgePort;
  private readonly sessionConfig: Record<string, unknown>;
  private readonly transport: RealtimeTransportAdapter;
  private readonly maxAudioFrameBase64: number;
  private readonly toolExecutor?: ToolExecutor;
  private readonly maxToolCallMs: number;
  private readonly onTranscript?: (entry: RealtimeBridgeTranscriptEntry) => void;
  private readonly onEnd?: (summary: { reason: string; pendingToolCalls: number }) => void;

  /** Carrier `hello`/`start` received — the call leg is live. */
  private helloSeen = false;
  /** OpenAI socket open + `session.update` sent. */
  private openaiReady = false;
  /** Bridge has ended — all further input is ignored. */
  private ended = false;
  /** Carrier call id from the `hello` event (46elks `callid` / Twilio `callSid`). */
  private callId = '';
  /** Audio frames received before OpenAI was ready, flushed on open. */
  private readonly pendingAudio: string[] = [];
  /** Oversized-frame counter — reported once, not per frame. */
  private droppedFrames = 0;
  private droppedFramesReported = false;
  /** Accumulated assistant speech transcript for the current response. */
  private assistantTranscript = '';
  /**
   * Function-call name keyed by `call_id`, captured from
   * `response.output_item.added`. The later `*.arguments.done` event is
   * not guaranteed to echo the tool name, so we remember it here.
   */
  private readonly toolCallNames = new Map<string, string>();
  /** `call_id`s whose tool call is currently executing. */
  private readonly inFlightToolCalls = new Set<string>();

  constructor(opts: RealtimeVoiceBridgeOptions) {
    const carrier = opts.carrier ?? opts.elks;
    if (!carrier) {
      throw new Error('RealtimeVoiceBridge requires a carrier (or elks) port');
    }
    this.carrier = carrier;
    this.openai = opts.openai;
    this.sessionConfig = opts.sessionConfig;
    // Default to the 46elks transport so callers that pass no `transport`
    // keep their exact prior behaviour. The 46elks `listen`/`send` format
    // options only apply to that default adapter.
    this.transport = opts.transport
      ?? new ElksRealtimeTransport(opts.listenFormat ?? 'pcm_24000', opts.sendFormat ?? 'pcm_24000');
    this.maxAudioFrameBase64 = opts.maxAudioFrameBase64 ?? REALTIME_MAX_AUDIO_FRAME_BASE64;
    this.toolExecutor = opts.toolExecutor;
    this.maxToolCallMs = opts.maxToolCallMs ?? REALTIME_TOOL_CALL_TIMEOUT_MS;
    this.onTranscript = opts.onTranscript;
    this.onEnd = opts.onEnd;
  }

  /** True once the bridge has ended. */
  get isEnded(): boolean {
    return this.ended;
  }

  /** The carrier call id, once the `hello`/`start` event has been seen. */
  get currentCallId(): string {
    return this.callId;
  }

  /** The carrier transport provider this bridge is running for. */
  get provider(): string {
    return this.transport.provider;
  }

  /** How many tool calls are executing right now. */
  get pendingToolCalls(): number {
    return this.inFlightToolCalls.size;
  }

  // ─── OpenAI side lifecycle ────────────────────────────

  /** Call when the OpenAI socket opens — sends `session.update`. */
  handleOpenAIOpen(): void {
    if (this.ended || this.openaiReady) return;
    this.openaiReady = true;
    this.safeSend(this.openai, this.sessionConfig);
    // Flush any audio that arrived during the connect window.
    for (const audio of this.pendingAudio.splice(0)) {
      this.safeSend(this.openai, { type: 'input_audio_buffer.append', audio });
    }
  }

  /** Call when the OpenAI socket closes. */
  handleOpenAIClose(): void {
    this.end('openai-closed');
  }

  /** Call when the OpenAI socket errors. */
  handleOpenAIError(err: unknown): void {
    this.emitTranscript('system', `OpenAI Realtime error: ${errorText(err)}`);
    this.end('openai-error');
  }

  // ─── Carrier side lifecycle ───────────────────────────

  /**
   * Call when the carrier media socket closes. The `onEnd` reason is
   * `<prefix>-closed`, where the prefix comes from the transport adapter
   * (`elks` for 46elks, `twilio` for Twilio) — so historical 46elks
   * reason strings (`elks-closed`) are preserved.
   */
  handleCarrierClose(): void {
    this.end(`${this.transport.endReasonPrefix}-closed`);
  }

  /** Call when the carrier media socket errors. */
  handleCarrierError(err: unknown): void {
    this.emitTranscript('system', `${this.transport.provider} media error: ${errorText(err)}`);
    this.end(`${this.transport.endReasonPrefix}-error`);
  }

  /** @deprecated 46elks-era alias for {@link handleCarrierClose}. */
  handleElksClose(): void {
    this.handleCarrierClose();
  }

  /** @deprecated 46elks-era alias for {@link handleCarrierError}. */
  handleElksError(err: unknown): void {
    this.handleCarrierError(err);
  }

  // ─── Carrier → OpenAI ─────────────────────────────────

  /**
   * Feed one raw message from the carrier media socket. Accepts a JSON
   * string or an already-parsed object. The transport adapter
   * normalises the provider-specific frame; malformed frames throw out
   * of the adapter and are ignored here (the bridge is never torn down
   * for one bad frame).
   */
  handleCarrierMessage(raw: string | Record<string, unknown>): void {
    if (this.ended) return;
    let event;
    try {
      event = this.transport.parseInbound(raw);
    } catch {
      // Unknown / malformed carrier frame — ignore, do not tear down.
      return;
    }

    if (event.kind === 'hello') {
      if (this.helloSeen) return; // one hello per call leg
      this.helloSeen = true;
      this.callId = event.callId;
      // Send any carrier-side handshake (46elks negotiates audio
      // formats; Twilio needs nothing — its handshake list is empty).
      for (const handshake of this.transport.buildHandshake()) {
        this.safeSend(this.carrier, handshake);
      }
      this.emitTranscript('system', 'Realtime voice bridge connected — live conversation started.', {
        provider: this.transport.provider,
        callId: this.callId,
        from: event.from,
        to: event.to,
      });
      return;
    }

    if (event.kind === 'audio') {
      this.forwardInboundAudio(event.data);
      return;
    }

    if (event.kind === 'bye') {
      this.emitTranscript('system', 'Caller side ended the call.', {
        reason: event.reason,
        message: event.message,
      });
      this.end(`${this.transport.endReasonPrefix}-bye`);
      return;
    }

    // event.kind === 'ignore' — a known-but-uninteresting carrier frame.
  }

  /** @deprecated 46elks-era alias for {@link handleCarrierMessage}. */
  handleElksMessage(raw: string | Record<string, unknown>): void {
    this.handleCarrierMessage(raw);
  }

  /** Relay caller audio to OpenAI, enforcing the per-frame size cap. */
  private forwardInboundAudio(base64: string): void {
    if (base64.length > this.maxAudioFrameBase64) {
      this.noteDroppedFrame();
      return;
    }
    if (!this.openaiReady) {
      if (this.pendingAudio.length < MAX_PENDING_AUDIO_FRAMES) {
        this.pendingAudio.push(base64);
      } else {
        this.noteDroppedFrame();
      }
      return;
    }
    this.safeSend(this.openai, { type: 'input_audio_buffer.append', audio: base64 });
  }

  // ─── OpenAI → 46elks ──────────────────────────────────

  /**
   * Feed one raw message from the OpenAI Realtime socket. Accepts a
   * JSON string or an already-parsed object. Unknown event types are
   * ignored.
   */
  handleOpenAIMessage(raw: string | Record<string, unknown>): void {
    if (this.ended) return;
    let event: Record<string, unknown>;
    try {
      event = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') return;
    const type = typeof event.type === 'string' ? event.type : '';

    switch (type) {
      // GA output-audio event; `response.audio.delta` is the legacy
      // beta name — handled defensively (some gpt-realtime deployments
      // still emit it). Both carry the base64 chunk in `delta`.
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) this.forwardOutboundAudio(delta);
        return;
      }

      // The caller started talking — barge-in. Tell the carrier to drop
      // any buffered playback so the agent stops mid-sentence (46elks
      // `interrupt` / Twilio `clear`).
      case 'input_audio_buffer.speech_started': {
        this.safeSend(this.carrier, this.transport.buildInterrupt());
        return;
      }

      // Assistant speech transcript — accumulate, flush on response end.
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta': {
        if (typeof event.delta === 'string') this.assistantTranscript += event.delta;
        return;
      }

      case 'response.done':
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const text = this.assistantTranscript.trim();
        if (text) this.emitTranscript('agent', text);
        this.assistantTranscript = '';
        return;
      }

      // Caller speech transcription, when input transcription is on.
      case 'conversation.item.input_audio_transcription.completed': {
        const text = typeof event.transcript === 'string' ? event.transcript.trim() : '';
        if (text) this.emitTranscript('provider', text, { speaker: 'caller' });
        return;
      }

      // A new output item was added to the response. When it is a
      // function call we capture `name` keyed by `call_id` here, because
      // the later `response.function_call_arguments.done` event is not
      // guaranteed to echo the tool name.
      case 'response.output_item.added': {
        const item = asRecord(event.item);
        if (item.type === 'function_call') {
          const callId = asString(item.call_id);
          const name = asString(item.name);
          if (callId && name) this.toolCallNames.set(callId, name);
        }
        return;
      }

      // Streamed function-call arguments. GA emits a `.delta` stream
      // then a single `.done` carrying the complete `arguments` JSON
      // string — we dispatch on `.done` and ignore the deltas.
      //
      // > Event names (`response.function_call_arguments.delta` /
      // > `.done`) and the `{ call_id, name, arguments }` fields follow
      // > the OpenAI Realtime function-calling protocol per the plan §3.
      // > Verify against current OpenAI docs before the live smoke test
      // > (same discipline as `response.output_audio.delta` in v0.9.52).
      case 'response.function_call_arguments.delta':
        return;
      case 'response.function_call_arguments.done': {
        this.dispatchToolCall(event);
        return;
      }

      case 'error': {
        const errObj = (event.error && typeof event.error === 'object')
          ? event.error as Record<string, unknown>
          : {};
        const message = typeof errObj.message === 'string' ? errObj.message : 'unknown error';
        this.emitTranscript('system', `OpenAI Realtime error: ${message}`, { error: errObj });
        return;
      }

      default:
        return;
    }
  }

  /** Relay synthesised agent audio to the carrier, enforcing the size cap. */
  private forwardOutboundAudio(base64: string): void {
    if (base64.length > this.maxAudioFrameBase64) {
      this.noteDroppedFrame();
      return;
    }
    try {
      this.safeSend(this.carrier, this.transport.buildAudio(base64));
    } catch {
      // The adapter rejects non-base64 (or a Twilio frame before its
      // streamSid is known) — drop the frame rather than crash.
      this.noteDroppedFrame();
    }
  }

  // ─── Function calling ─────────────────────────────────

  /**
   * Parse a `response.function_call_arguments.done` event and dispatch
   * the tool call. Resolves `name` from the event or the map captured
   * on `response.output_item.added`; parses `arguments` (a JSON string)
   * defensively. Always answers the model — an unknown name, missing
   * executor, or oversized fan-out each gets a model-readable output
   * rather than being dropped (a dropped `call_id` wedges the model,
   * which waits forever for its `function_call_output`).
   */
  private dispatchToolCall(event: Record<string, unknown>): void {
    const callId = asString(event.call_id);
    if (!callId) return; // cannot answer a call with no id — nothing to key on
    const name = asString(event.name) || this.toolCallNames.get(callId) || '';

    if (this.inFlightToolCalls.has(callId)) return; // duplicate `.done` — ignore

    if (!name) {
      this.answerToolCall(callId, 'Tool call ignored — no tool name was provided.');
      return;
    }
    if (!this.toolExecutor) {
      this.answerToolCall(callId, `No tools are available on this call, so "${name}" cannot run.`);
      return;
    }
    if (this.inFlightToolCalls.size >= MAX_IN_FLIGHT_TOOL_CALLS) {
      this.answerToolCall(callId, `Too many tool calls are already in flight; "${name}" was refused.`);
      return;
    }

    const args = parseToolArguments(event.arguments);
    this.inFlightToolCalls.add(callId);
    this.emitTranscript('system', `Tool call: ${name}`, { callId, arguments: args });
    void this.runToolCall({ callId, name, arguments: args });
  }

  /** Execute one tool call, racing the executor against the safety-net timeout. */
  private async runToolCall(call: RealtimeToolCall): Promise<void> {
    let output: string;
    try {
      const result = await withTimeout(
        Promise.resolve(this.toolExecutor!.execute(call)),
        this.maxToolCallMs,
      );
      output = result.output;
    } catch (err) {
      // The executor itself never rejects (createToolExecutor catches),
      // so reaching here means the safety-net timeout fired — the tool
      // hung. Give the model something it can gracefully recover from.
      output = `The "${call.name}" tool did not finish in time (${errorText(err)}). `
        + 'Tell the caller you could not complete that just now and will follow up.';
    }
    this.inFlightToolCalls.delete(call.callId);
    this.toolCallNames.delete(call.callId);
    // The call may have ended while the tool ran (caller hung up). The
    // OpenAI socket is gone — sending a result would throw; and an
    // unanswered query is exactly what arms callback-on-disconnect.
    if (this.ended) return;
    this.emitTranscript('system', `Tool result: ${truncate(output, 240)}`, { callId: call.callId });
    this.answerToolCall(call.callId, output);
  }

  /**
   * Send a tool result back to OpenAI: a `function_call_output`
   * conversation item, then `response.create` so the model resumes
   * speaking with the result in hand.
   *
   * > `conversation.item.create` with `{ type: 'function_call_output',
   * > call_id, output }` followed by `response.create` is the OpenAI
   * > Realtime function-calling return path per the plan §3. Verify
   * > against current OpenAI docs before the live smoke test.
   */
  private answerToolCall(callId: string, output: string): void {
    this.safeSend(this.openai, {
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    this.safeSend(this.openai, { type: 'response.create' });
  }

  // ─── Teardown ─────────────────────────────────────────

  /**
   * End the bridge. Idempotent — the first call wins, later calls are
   * no-ops. Sends the carrier's end-of-call frame (if it has one — 46elks
   * `bye`; Twilio has none), closes both ports, fires `onEnd`.
   */
  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.droppedFrames > 0) {
      this.onTranscript?.({
        source: 'system',
        text: `Dropped ${this.droppedFrames} oversized/invalid audio frame(s) during the call.`,
      });
    }
    // Tool calls still running at teardown — the call dropped mid-tool.
    // Surface it on the transcript; `onEnd.pendingToolCalls` is the
    // signal the API layer uses to arm callback-on-disconnect (plan §7).
    const pendingToolCalls = this.inFlightToolCalls.size;
    if (pendingToolCalls > 0) {
      this.onTranscript?.({
        source: 'system',
        text: `Call ended with ${pendingToolCalls} tool call(s) still pending (e.g. an unanswered operator query).`,
      });
    }
    // Best-effort end-of-call frame to the carrier (if the protocol has
    // one), then close both sides.
    const byeFrame = this.transport.buildBye();
    if (byeFrame) {
      try { this.carrier.send(byeFrame); } catch { /* ignore */ }
    }
    try { this.carrier.close(); } catch { /* ignore */ }
    try { this.openai.close(); } catch { /* ignore */ }
    this.onEnd?.({ reason, pendingToolCalls });
  }

  // ─── Internals ────────────────────────────────────────

  private noteDroppedFrame(): void {
    this.droppedFrames += 1;
    if (!this.droppedFramesReported) {
      this.droppedFramesReported = true;
      this.emitTranscript('system', 'An oversized or invalid audio frame was dropped (size cap enforced).');
    }
  }

  private emitTranscript(
    source: RealtimeBridgeTranscriptEntry['source'],
    text: string,
    metadata?: Record<string, unknown>,
  ): void {
    try {
      this.onTranscript?.({ source, text, ...(metadata ? { metadata } : {}) });
    } catch {
      // A throwing transcript sink must never break the bridge.
    }
  }

  private safeSend(port: RealtimeBridgePort, message: Record<string, unknown>): void {
    try {
      port.send(message);
    } catch {
      // A dead socket throwing on send must not crash the bridge —
      // the matching close handler will tear things down cleanly.
    }
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

/** Coerce a value to a plain object, or `{}` for anything else. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Coerce a value to a trimmed string, or `''` for a non-string. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Truncate a string for transcript lines, adding an ellipsis if cut. */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Parse the `arguments` field of a function-call event — a JSON string
 * per the OpenAI Realtime protocol. Returns `{}` for anything that is
 * not a JSON object, so a buggy/hostile payload can never inject a
 * non-object into a tool handler.
 */
function parseToolArguments(raw: unknown): Record<string, unknown> {
  const text = asString(raw);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Race a promise against a timeout. Rejects with a timeout error if the
 * promise has not settled within `ms`; the pending timer is always
 * cleared so it cannot keep the event loop alive.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`tool call exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
