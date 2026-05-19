import { describe, expect, it } from 'vitest';
import {
  RealtimeVoiceBridge,
  buildRealtimeSessionConfig,
  type RealtimeBridgePort,
} from '../phone/realtime-bridge.js';
import {
  TwilioRealtimeTransport,
  createRealtimeTransport,
} from '../phone/realtime-transport.js';
import {
  ASK_OPERATOR_TOOL,
  type RealtimeToolCall,
  type ToolExecutor,
} from '../phone/realtime-tools.js';

/** Flush pending microtasks + timers so an async tool dispatch settles. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A fake bridge port that records every message + whether it was closed. */
class FakePort implements RealtimeBridgePort {
  sent: Record<string, unknown>[] = [];
  closed = false;
  send(message: Record<string, unknown>): void { this.sent.push(message); }
  close(): void { this.closed = true; }
  /** Messages with a given `event` (Twilio) or `type` (OpenAI) field. */
  ofKind(kind: string): Record<string, unknown>[] {
    return this.sent.filter((m) => m.event === kind || m.type === kind);
  }
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

/** Twilio's `connected` then `start` frames — the call-leg-live signal. */
function connectedFrame() {
  return { event: 'connected', protocol: 'Call', version: '1.0.0' };
}
function startFrame(streamSid = 'MZ-stream', callSid = 'CA-call') {
  return { event: 'start', start: { streamSid, callSid, accountSid: 'AC1' } };
}
function mediaFrame(text: string) {
  return { event: 'media', media: { payload: b64(text), track: 'inbound' } };
}

function makeTwilioBridge(opts: Partial<ConstructorParameters<typeof RealtimeVoiceBridge>[0]> = {}) {
  const carrier = new FakePort();
  const openai = new FakePort();
  const transcript: { source: string; text: string }[] = [];
  const ends: { reason: string; pendingToolCalls: number }[] = [];
  const transport = new TwilioRealtimeTransport();
  const bridge = new RealtimeVoiceBridge({
    carrier,
    openai,
    transport,
    sessionConfig: buildRealtimeSessionConfig({
      task: 'Confirm the appointment',
      audioFormat: transport.openaiAudioFormat,
    }),
    onTranscript: (e) => transcript.push({ source: e.source, text: e.text }),
    onEnd: (s) => ends.push(s),
    ...opts,
  });
  return { bridge, carrier, openai, transcript, ends, transport };
}

describe('createRealtimeTransport', () => {
  it('returns the Twilio adapter for "twilio" and the 46elks adapter otherwise', () => {
    expect(createRealtimeTransport('twilio').provider).toBe('twilio');
    expect(createRealtimeTransport('46elks').provider).toBe('46elks');
  });
});

describe('buildRealtimeSessionConfig — Twilio µ-law audio', () => {
  it('uses audio/pcmu @ 8 kHz for input and output when given the Twilio format', () => {
    const transport = new TwilioRealtimeTransport();
    const cfg = buildRealtimeSessionConfig({
      task: 'x', audioFormat: transport.openaiAudioFormat,
    }) as any;
    expect(cfg.session.audio.input.format).toEqual({ type: 'audio/pcmu', rate: 8000 });
    expect(cfg.session.audio.output.format).toEqual({ type: 'audio/pcmu', rate: 8000 });
  });

  it('still defaults to PCM @ 24 kHz when no audioFormat is supplied (46elks)', () => {
    const cfg = buildRealtimeSessionConfig({ task: 'x' }) as any;
    expect(cfg.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
  });
});

describe('RealtimeVoiceBridge — Twilio → OpenAI', () => {
  it('treats the start frame as the call-leg-live signal and ignores connected', () => {
    const { bridge, openai } = makeTwilioBridge();
    bridge.handleCarrierMessage(connectedFrame()); // handshake noise — no-op
    expect(bridge.currentCallId).toBe('');

    bridge.handleCarrierMessage(startFrame());
    // Twilio has no carrier handshake, so nothing is sent to the carrier.
    expect(bridge.currentCallId).toBe('CA-call');
    expect(bridge.provider).toBe('twilio');

    // Audio before OpenAI is ready buffers; it flushes on open.
    bridge.handleCarrierMessage(mediaFrame('caller speech'));
    expect(openai.sent).toHaveLength(0);
    bridge.handleOpenAIOpen();
    expect(openai.sent[0].type).toBe('session.update');
    expect(openai.sent[1]).toEqual({ type: 'input_audio_buffer.append', audio: b64('caller speech') });
  });

  it('only honours the first start frame', () => {
    const { bridge } = makeTwilioBridge();
    bridge.handleCarrierMessage(startFrame('MZ1', 'CA1'));
    bridge.handleCarrierMessage(startFrame('MZ2', 'CA2'));
    expect(bridge.currentCallId).toBe('CA1');
  });

  it('ends on a Twilio stop frame', () => {
    const { bridge, openai, ends } = makeTwilioBridge();
    bridge.handleCarrierMessage(startFrame());
    bridge.handleOpenAIOpen();
    bridge.handleCarrierMessage({ event: 'stop', stop: { callSid: 'CA-call' } });
    expect(bridge.isEnded).toBe(true);
    expect(openai.closed).toBe(true);
    expect(ends[0].reason).toBe('twilio-bye');
  });

  it('ignores a Twilio mark frame without tearing down', () => {
    const { bridge } = makeTwilioBridge();
    bridge.handleCarrierMessage(startFrame());
    bridge.handleOpenAIOpen();
    expect(() => bridge.handleCarrierMessage({ event: 'mark', mark: { name: 'turn-end' } })).not.toThrow();
    expect(bridge.isEnded).toBe(false);
  });

  it('ignores a malformed Twilio frame without tearing down', () => {
    const { bridge } = makeTwilioBridge();
    bridge.handleCarrierMessage(startFrame());
    bridge.handleOpenAIOpen();
    expect(() => bridge.handleCarrierMessage('not json')).not.toThrow();
    expect(() => bridge.handleCarrierMessage({ event: 'media', media: { payload: 'bad' } })).not.toThrow();
    expect(bridge.isEnded).toBe(false);
  });
});

describe('RealtimeVoiceBridge — OpenAI → Twilio', () => {
  it('relays output audio deltas to Twilio as media frames echoing the streamSid', () => {
    const { bridge, carrier } = makeTwilioBridge();
    bridge.handleCarrierMessage(startFrame('MZ-abc', 'CA-abc'));
    bridge.handleOpenAIOpen();

    bridge.handleOpenAIMessage({ type: 'response.output_audio.delta', delta: b64('agent voice') });
    const media = carrier.ofKind('media');
    expect(media).toHaveLength(1);
    expect(media[0]).toEqual({
      event: 'media', streamSid: 'MZ-abc', media: { payload: b64('agent voice') },
    });
  });

  it('sends a Twilio clear (barge-in) on caller speech-started', () => {
    const { bridge, carrier } = makeTwilioBridge();
    bridge.handleCarrierMessage(startFrame('MZ-abc'));
    bridge.handleOpenAIOpen();
    bridge.handleOpenAIMessage({ type: 'input_audio_buffer.speech_started' });
    expect(carrier.ofKind('clear')).toEqual([{ event: 'clear', streamSid: 'MZ-abc' }]);
  });

  it('closes both sides on teardown — Twilio has no bye frame', () => {
    const { bridge, carrier, openai } = makeTwilioBridge();
    bridge.handleCarrierMessage(startFrame());
    bridge.handleOpenAIOpen();
    bridge.end('done');
    // No 46elks-style `bye` frame is sent — the protocol has none.
    expect(carrier.ofKind('bye')).toHaveLength(0);
    expect(carrier.closed).toBe(true);
    expect(openai.closed).toBe(true);
  });
});

describe('RealtimeVoiceBridge — Twilio function calling', () => {
  function fakeExecutor(output = 'tool done'): { executor: ToolExecutor; calls: RealtimeToolCall[] } {
    const calls: RealtimeToolCall[] = [];
    return { calls, executor: { execute: async (call) => { calls.push(call); return { output }; } } };
  }

  it('dispatches a function call over a Twilio bridge exactly as for 46elks', async () => {
    const { executor, calls } = fakeExecutor('Confirmed for 3pm.');
    const { bridge, openai } = makeTwilioBridge({ toolExecutor: executor });
    bridge.handleCarrierMessage(startFrame());
    bridge.handleOpenAIOpen();

    bridge.handleOpenAIMessage({
      type: 'response.output_item.added',
      item: { type: 'function_call', call_id: 'fc1', name: 'ask_operator' },
    });
    bridge.handleOpenAIMessage({
      type: 'response.function_call_arguments.done',
      call_id: 'fc1', arguments: '{"question":"is 3pm ok?"}',
    });
    await flush();

    expect(calls[0]).toEqual({ callId: 'fc1', name: 'ask_operator', arguments: { question: 'is 3pm ok?' } });
    const created = openai.ofKind('conversation.item.create')[0] as any;
    expect(created.item).toEqual({ type: 'function_call_output', call_id: 'fc1', output: 'Confirmed for 3pm.' });
  });

  it('surfaces in-flight tool calls to onEnd for callback-on-disconnect', async () => {
    const executor: ToolExecutor = { execute: () => new Promise(() => { /* never settles */ }) };
    const { bridge, ends } = makeTwilioBridge({ toolExecutor: executor });
    bridge.handleCarrierMessage(startFrame());
    bridge.handleOpenAIOpen();
    bridge.handleOpenAIMessage({
      type: 'response.output_item.added',
      item: { type: 'function_call', call_id: 'fc1', name: 'ask_operator' },
    });
    bridge.handleOpenAIMessage({ type: 'response.function_call_arguments.done', call_id: 'fc1', arguments: '{}' });
    await flush();
    expect(bridge.pendingToolCalls).toBe(1);

    bridge.handleCarrierMessage({ event: 'stop' });
    expect(ends[0]).toEqual({ reason: 'twilio-bye', pendingToolCalls: 1 });
  });

  it('declares ask_operator on a Twilio session config', () => {
    const transport = new TwilioRealtimeTransport();
    const cfg = buildRealtimeSessionConfig({
      task: 'x', tools: [ASK_OPERATOR_TOOL], audioFormat: transport.openaiAudioFormat,
    }) as any;
    expect(cfg.session.tools[0].name).toBe('ask_operator');
  });
});
