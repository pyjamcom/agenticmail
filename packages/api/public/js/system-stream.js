// Single shared SSE connection to /system/events.
//
// # Why this exists
//
// Browsers cap HTTP connections at 6 per origin. The old web UI opened
// ONE per-agent /events SSE plus ONE /system/events SSE — so with 5
// agents, that's 6 long-lived connections, exhausting the cap. Every
// other request (page refresh, message fetch, attachment download)
// had to wait for an SSE slot to free up, which never happened
// because they're persistent.
//
// Fix: every per-agent new-mail event is now also pushed to
// /system/events by the API. The UI subscribes ONCE here, and modules
// register handlers via `onSystemEvent(type, handler)`. Net effect:
// 6 SSE connections → 1, freeing 5 slots for actual HTTP traffic.
//
// # API
//
//   import { connectSystemStream, onSystemEvent } from './system-stream.js';
//   connectSystemStream();                        // wire it up once after sign-in
//   onSystemEvent('new_mail', (e) => { ... });    // subscribe to event type
//   onSystemEvent('worker_started', (e) => {});   // ANY type the server emits
//
// Multiple subscribers per type are supported. Each handler runs in
// try/catch so one buggy handler can't kill the others.

import { state, API_URL } from './state.js';

let controller = null;
let connected = false;
const handlers = new Map();          // type → Set<handler>

export function onSystemEvent(type, handler) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(handler);
  return () => handlers.get(type)?.delete(handler);
}

function dispatch(event) {
  if (!event || typeof event !== 'object') return;
  const set = handlers.get(event.type);
  if (!set) return;
  for (const h of set) {
    try { h(event); } catch (err) { console.error('[system-stream] handler error', err); }
  }
}

export function connectSystemStream() {
  if (controller) { try { controller.abort(); } catch {} }
  controller = new AbortController();
  connected = false;
  const sig = controller.signal;

  // Auto-reconnect with exponential backoff. Capped at 30s — keeping
  // a UI live during a long server outage shouldn't slam the API
  // every two seconds.
  let backoff = 1000;
  const loop = async () => {
    while (!sig.aborted) {
      try {
        const res = await fetch(`${API_URL}/api/agenticmail/system/events`, {
          headers: { Authorization: `Bearer ${state.masterKey}`, Accept: 'text/event-stream' },
          signal: sig,
        });
        if (!res.ok || !res.body) {
          // Hard 4xx (auth) → stop trying; user has to refresh / sign in again.
          if (res.status === 401 || res.status === 403) return;
          throw new Error(`/system/events HTTP ${res.status}`);
        }
        connected = true;
        backoff = 1000;  // healthy connection — reset
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (!sig.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try { dispatch(JSON.parse(line.slice(6))); } catch {}
            }
          }
        }
      } catch (err) {
        if (sig.aborted) return;
        // Stream dropped — wait + reconnect.
      }
      connected = false;
      if (sig.aborted) return;
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  };
  loop();
}

export function isSystemStreamConnected() {
  return connected;
}

export function disconnectSystemStream() {
  if (controller) { try { controller.abort(); } catch {} }
  controller = null;
  connected = false;
}
