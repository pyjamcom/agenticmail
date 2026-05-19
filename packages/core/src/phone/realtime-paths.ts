/**
 * Realtime voice WebSocket endpoint paths.
 *
 * These are the URL paths a phone carrier's media socket connects to.
 * They live in `@agenticmail/core` (rather than only in the API
 * package) because the {@link PhoneManager} needs the Twilio path to
 * build the `<Stream url>` inside the TwiML it returns from the Twilio
 * voice webhook. The API package mounts its WebSocket servers on the
 * same constants, so the path is defined exactly once.
 */

/**
 * Path the 46elks websocket-number's `websocket_url` points at. 46elks
 * resolves the mission from the `hello` frame's `callid`, so the path
 * carries no mission identity itself.
 */
export const ELKS_REALTIME_WS_PATH = '/api/agenticmail/calls/realtime';

/**
 * Path a Twilio `<Connect><Stream>` connects to. The mission id + token
 * ride as query params (and as `<Parameter>` values in the TwiML), so
 * the media socket can be matched to its mission before the Twilio
 * `start` frame even arrives.
 */
export const TWILIO_REALTIME_WS_PATH = '/api/agenticmail/calls/twilio-stream';
