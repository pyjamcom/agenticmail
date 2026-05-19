import { describe, expect, it } from 'vitest';
import {
  buildTwilioClearMessage,
  buildTwilioMarkMessage,
  buildTwilioMediaMessage,
  parseTwilioRealtimeMessage,
} from '../phone/index.js';

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('Twilio Media Streams protocol helpers', () => {
  it('parses connected, start, media, mark, and stop frames', () => {
    expect(parseTwilioRealtimeMessage({ event: 'connected', protocol: 'Call', version: '1.0.0' }))
      .toMatchObject({ event: 'connected', protocol: 'Call' });

    expect(parseTwilioRealtimeMessage(JSON.stringify({
      event: 'start',
      start: {
        streamSid: 'MZ123',
        callSid: 'CA456',
        accountSid: 'AC789',
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        tracks: ['inbound'],
        customParameters: { missionId: 'call_abc' },
      },
    }))).toMatchObject({
      event: 'start',
      streamSid: 'MZ123',
      callSid: 'CA456',
      accountSid: 'AC789',
      tracks: ['inbound'],
      customParameters: { missionId: 'call_abc' },
    });

    expect(parseTwilioRealtimeMessage({
      event: 'media',
      media: { payload: b64('caller audio'), track: 'inbound', chunk: '1', timestamp: '20' },
    })).toEqual({ event: 'media', payload: b64('caller audio'), track: 'inbound' });

    expect(parseTwilioRealtimeMessage({ event: 'mark', mark: { name: 'turn-end' } }))
      .toEqual({ event: 'mark', name: 'turn-end' });

    expect(parseTwilioRealtimeMessage({ event: 'stop', stop: { callSid: 'CA456' } }))
      .toMatchObject({ event: 'stop', callSid: 'CA456' });
  });

  it('rejects malformed inbound frames fail-closed', () => {
    expect(() => parseTwilioRealtimeMessage('{broken')).toThrow(/JSON object/);
    // start missing callSid
    expect(() => parseTwilioRealtimeMessage({ event: 'start', start: { streamSid: 'MZ1' } }))
      .toThrow(/streamSid and callSid/);
    // media with non-base64 payload
    expect(() => parseTwilioRealtimeMessage({ event: 'media', media: { payload: 'not base64' } }))
      .toThrow(/base64/);
    expect(() => parseTwilioRealtimeMessage({ event: 'unknown' })).toThrow(/Unsupported/);
  });

  it('builds outbound media frames from bytes or encoded strings, echoing the streamSid', () => {
    expect(buildTwilioMediaMessage('MZ123', new Uint8Array([1, 2, 3]))).toEqual({
      event: 'media', streamSid: 'MZ123', media: { payload: 'AQID' },
    });
    expect(buildTwilioMediaMessage('MZ123', 'AQID')).toEqual({
      event: 'media', streamSid: 'MZ123', media: { payload: 'AQID' },
    });
    expect(() => buildTwilioMediaMessage('MZ123', 'bad audio')).toThrow(/base64/);
    expect(() => buildTwilioMediaMessage('', 'AQID')).toThrow(/streamSid/);
  });

  it('builds clear (barge-in) and mark control frames', () => {
    expect(buildTwilioClearMessage('MZ123')).toEqual({ event: 'clear', streamSid: 'MZ123' });
    expect(buildTwilioMarkMessage('MZ123', 'turn-end')).toEqual({
      event: 'mark', streamSid: 'MZ123', mark: { name: 'turn-end' },
    });
    expect(() => buildTwilioClearMessage('')).toThrow(/streamSid/);
    expect(() => buildTwilioMarkMessage('', 'n')).toThrow(/streamSid/);
  });
});
