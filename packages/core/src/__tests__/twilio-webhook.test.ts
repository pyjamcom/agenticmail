import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildTwilioSignature,
  validateTwilioSignature,
  buildTwilioStreamTwiML,
  buildTwilioSayTwiML,
  escapeXml,
} from '../phone/index.js';

const AUTH_TOKEN = 'twilio-auth-token-abcdefghijklmnop';

/** Reference signature, computed independently of buildTwilioSignature. */
function referenceSignature(url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', AUTH_TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
}

describe('Twilio webhook signature', () => {
  const url = 'https://agenticmail.example.com/api/agenticmail/calls/webhook/twilio/voice?missionId=call_x';
  const params = { CallSid: 'CA1', From: '+15550001111', To: '+15550002222' };

  it('computes the signature as HMAC-SHA1 over URL + sorted params', () => {
    // Matches an independent reference computation.
    expect(buildTwilioSignature(AUTH_TOKEN, url, params)).toBe(referenceSignature(url, params));
    // Param ordering must not matter — keys are sorted before signing.
    const reordered = { To: params.To, CallSid: params.CallSid, From: params.From };
    expect(buildTwilioSignature(AUTH_TOKEN, url, reordered))
      .toBe(buildTwilioSignature(AUTH_TOKEN, url, params));
  });

  it('validates a correct signature', () => {
    const signature = buildTwilioSignature(AUTH_TOKEN, url, params);
    expect(validateTwilioSignature(AUTH_TOKEN, url, params, signature)).toBe(true);
  });

  it('rejects a forged or tampered signature fail-closed', () => {
    const good = buildTwilioSignature(AUTH_TOKEN, url, params);
    // Wrong signature string.
    expect(validateTwilioSignature(AUTH_TOKEN, url, params, 'not-the-signature')).toBe(false);
    // A tampered param invalidates the (otherwise valid) signature.
    expect(validateTwilioSignature(AUTH_TOKEN, url, { ...params, To: '+15559999999' }, good)).toBe(false);
    // A tampered URL invalidates it too.
    expect(validateTwilioSignature(AUTH_TOKEN, `${url}&extra=1`, params, good)).toBe(false);
    // The wrong auth token cannot have produced it.
    expect(validateTwilioSignature('wrong-token', url, params, good)).toBe(false);
    // Missing inputs fail closed — never throw.
    expect(validateTwilioSignature('', url, params, good)).toBe(false);
    expect(validateTwilioSignature(AUTH_TOKEN, url, params, '')).toBe(false);
  });
});

describe('Twilio TwiML generation', () => {
  it('builds a Connect/Stream document with escaped parameters', () => {
    const twiml = buildTwilioStreamTwiML({
      streamUrl: 'wss://host/api/agenticmail/calls/twilio-stream?missionId=call_x&token=abc',
      parameters: { missionId: 'call_x', token: 'abc' },
    });
    expect(twiml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(twiml).toContain('<Connect>');
    expect(twiml).toContain('<Stream url=');
    // The `&` in the stream URL query string must be XML-escaped.
    expect(twiml).toContain('missionId=call_x&amp;token=abc');
    expect(twiml).toContain('<Parameter name="missionId" value="call_x"/>');
    expect(twiml).toContain('<Parameter name="token" value="abc"/>');
    // Well-formed: the Response element opens and closes.
    expect(twiml.endsWith('</Response>')).toBe(true);
  });

  it('builds a fallback Say document', () => {
    const twiml = buildTwilioSayTwiML('The operator will follow up.');
    expect(twiml).toContain('<Say>The operator will follow up.</Say>');
  });

  it('escapes XML metacharacters', () => {
    expect(escapeXml('a & b < c > d "e" \'f\'')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;',
    );
  });

  it('rejects a stream TwiML with no stream URL', () => {
    expect(() => buildTwilioStreamTwiML({ streamUrl: '' })).toThrow(/streamUrl/);
  });
});
