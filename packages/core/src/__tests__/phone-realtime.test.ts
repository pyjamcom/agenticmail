import { describe, expect, it } from 'vitest';
import {
  buildElksAudioMessage,
  buildElksByeMessage,
  buildElksHandshakeMessages,
  buildElksInterruptMessage,
  buildElksListeningMessage,
  buildElksSendingMessage,
  parseElksRealtimeMessage,
} from '../phone/index.js';

describe('46elks realtime voice protocol helpers', () => {
  it('parses hello, audio, and bye messages', () => {
    expect(parseElksRealtimeMessage({
      t: 'hello',
      callid: 'call123',
      from: '+43123456789',
      to: '+436641234567',
      extra: 'kept',
    })).toMatchObject({
      t: 'hello',
      callid: 'call123',
      from: '+43123456789',
      to: '+436641234567',
      extra: 'kept',
    });

    expect(parseElksRealtimeMessage(JSON.stringify({
      t: 'audio',
      data: Buffer.from('hello').toString('base64'),
    }))).toEqual({
      t: 'audio',
      data: 'aGVsbG8=',
    });

    expect(parseElksRealtimeMessage({
      t: 'bye',
      reason: 'hangup',
      message: 'caller hung up',
    })).toMatchObject({
      t: 'bye',
      reason: 'hangup',
      message: 'caller hung up',
    });
  });

  it('rejects malformed inbound messages fail-closed', () => {
    expect(() => parseElksRealtimeMessage('{broken')).toThrow(/JSON object/);
    expect(() => parseElksRealtimeMessage({ t: 'hello', callid: 'call123' })).toThrow(/callid, from, and to/);
    expect(() => parseElksRealtimeMessage({ t: 'audio', data: 'not base64' })).toThrow(/base64/);
    expect(() => parseElksRealtimeMessage({ t: 'sync' })).toThrow(/Unsupported/);
  });

  it('builds outbound negotiation and control messages', () => {
    expect(buildElksListeningMessage()).toEqual({ t: 'listening', format: 'pcm_24000' });
    expect(buildElksSendingMessage('ulaw')).toEqual({ t: 'sending', format: 'ulaw' });
    expect(buildElksHandshakeMessages()).toEqual([
      { t: 'listening', format: 'pcm_24000' },
      { t: 'sending', format: 'pcm_24000' },
    ]);
    expect(buildElksInterruptMessage()).toEqual({ t: 'interrupt' });
    expect(buildElksByeMessage()).toEqual({ t: 'bye' });
  });

  it('builds base64 audio messages from bytes or encoded strings', () => {
    expect(buildElksAudioMessage(new Uint8Array([1, 2, 3]))).toEqual({
      t: 'audio',
      data: 'AQID',
    });
    expect(buildElksAudioMessage('AQID')).toEqual({
      t: 'audio',
      data: 'AQID',
    });
    expect(() => buildElksAudioMessage('bad audio')).toThrow(/base64/);
  });
});
