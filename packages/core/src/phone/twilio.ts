/**
 * Twilio webhook helpers — request-signature validation and TwiML
 * generation.
 *
 * This is the call-control counterpart of the 46elks webhook handling
 * in `manager.ts`. Twilio secures every webhook it sends with an
 * `X-Twilio-Signature` header; we answer Twilio's voice webhook with
 * TwiML (an XML document) that connects the call's audio to the
 * realtime voice WebSocket.
 *
 * Everything here is pure (no I/O, no sockets) so it is fully
 * unit-testable and keeps `@agenticmail/core` dependency-light.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compute the Twilio request signature for a webhook request.
 *
 * Twilio's scheme (per its Security docs): take the full request URL,
 * then for an `application/x-www-form-urlencoded` POST append every
 * POST parameter — sorted by key — as `key` immediately followed by
 * `value`, with no separators. HMAC-SHA1 that string keyed by the
 * account `AuthToken`, and base64-encode the digest. Twilio sends the
 * result in the `X-Twilio-Signature` header.
 *
 * > Verify the exact construction against Twilio's current Security
 * > documentation before the live smoke-test.
 *
 * @param authToken  the Twilio account AuthToken (the signing key)
 * @param url        the full URL Twilio requested, exactly as configured
 * @param params     the POST body parameters (form-encoded fields)
 */
export function buildTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string> = {},
): string {
  // Sort param keys and concatenate `key + value` with no delimiter.
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

/**
 * Validate an `X-Twilio-Signature` header against the request, timing-
 * safe. Fails closed: a missing/empty signature or token, or any
 * mismatch, returns `false` — never throws. The comparison is constant-
 * time so a caller cannot probe the expected signature byte by byte.
 */
export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  providedSignature: string,
): boolean {
  if (!authToken || !url || !providedSignature) return false;
  const expected = buildTwilioSignature(authToken, url, params);
  const a = Buffer.from(providedSignature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Constant-time compare — bail before timingSafeEqual on a length
  // mismatch (it throws on unequal-length buffers).
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * XML-escape a string for safe inclusion in a TwiML attribute or text
 * node. TwiML is XML, so any value we interpolate (a websocket URL with
 * query params, a `<Parameter>` value) must have its metacharacters
 * escaped or a stray `&`/`"` would produce malformed XML.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface TwilioStreamTwiMLOptions {
  /** The `wss://…` URL Twilio should open a Media Stream to. */
  streamUrl: string;
  /**
   * `<Parameter>` name/value pairs nested in the `<Stream>` — Twilio
   * echoes them back inside the media-stream `start` event's
   * `customParameters`. Used to carry the mission id / token so the
   * media socket can be matched to its phone mission even though the
   * `<Stream>` URL itself is fixed.
   */
  parameters?: Record<string, string>;
}

/**
 * Build the TwiML returned from the Twilio voice webhook: a
 * `<Connect><Stream>` document that hands the live call audio to our
 * realtime voice WebSocket.
 *
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <Response>
 *     <Connect>
 *       <Stream url="wss://host/path">
 *         <Parameter name="missionId" value="…"/>
 *       </Stream>
 *     </Connect>
 *   </Response>
 *
 * `<Connect><Stream>` (as opposed to `<Start><Stream>`) makes the
 * stream bidirectional and keeps the call alive for its duration — the
 * call ends when the stream ends. Every interpolated value is
 * XML-escaped.
 *
 * > The `<Connect><Stream>` / `<Parameter>` TwiML verbs are per
 * > Twilio's public Media Streams docs; verify against current docs
 * > before the live smoke-test.
 */
export function buildTwilioStreamTwiML(opts: TwilioStreamTwiMLOptions): string {
  if (!opts.streamUrl) throw new Error('buildTwilioStreamTwiML requires a streamUrl');
  const parameters = opts.parameters ?? {};
  const parameterTags = Object.entries(parameters)
    .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(String(value))}"/>`)
    .join('');
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Response>'
    + '<Connect>'
    + `<Stream url="${escapeXml(opts.streamUrl)}">${parameterTags}</Stream>`
    + '</Connect>'
    + '</Response>';
}

/**
 * Build a minimal `<Response><Say>…</Say></Response>` TwiML document —
 * the fallback Twilio voice response when the realtime voice runtime
 * cannot be connected (e.g. no OpenAI key). Mirrors the 46elks
 * voice-start `play` action.
 */
export function buildTwilioSayTwiML(message: string): string {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Response>'
    + `<Say>${escapeXml(message)}</Say>`
    + '</Response>';
}
