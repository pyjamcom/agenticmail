/**
 * Cloudflare quick-tunnel watchdog.
 *
 * Cloudflare quick-tunnels (`cloudflared tunnel --url http://...`)
 * are "not durable" — their lifetime is undefined and they can die
 * silently from a process kill, an upstream edge reconnect failure,
 * or just Cloudflare rotating infrastructure. When that happens,
 * Twilio's TwiML voice webhook fetches against the dead URL fail
 * with NXDOMAIN, Twilio plays its stock "We're sorry, an
 * application error has occurred" message, and the call dies before
 * the bridge ever sees the audio stream.
 *
 * This watchdog runs inside the API server, periodically pings the
 * tunnel URL via the local API's /health endpoint (proves the
 * round-trip from Cloudflare → tunnel → us → tunnel → Cloudflare),
 * and on three consecutive failures:
 *
 *   1. Declare the tunnel dead.
 *   2. Spawn a new `cloudflared tunnel --url http://127.0.0.1:<port>`,
 *      capture the new `*.trycloudflare.com` URL from its stdout.
 *   3. Persist the new URL to `~/.agenticmail/tunnel.json`.
 *   4. For every phone-transport config whose webhookBaseUrl matches
 *      the OLD URL, update to the new one via
 *      `PhoneManager.savePhoneTransportConfig`. The Twilio API doesn't
 *      need to be re-notified — Twilio fetches the webhook URL fresh
 *      on each call's `Url` parameter at dial time.
 *
 * No-op when no tunnel file exists (the operator brought their own
 * domain, no quick-tunnel involved). Best-effort throughout; the
 * watchdog is the difference between "next call works automatically"
 * and "operator notices a silent failure", but the call placement
 * path doesn't depend on it.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import {
  PhoneManager,
  validatePhoneTransportProfile,
  type AgenticMailConfig,
} from '@agenticmail/core';
import type { getDatabase } from '@agenticmail/core';

type Db = ReturnType<typeof getDatabase>;

/** Default health-check interval — once a minute. Cheap (local HTTP GET). */
export const DEFAULT_TUNNEL_PING_INTERVAL_MS = 60_000;

/** Consecutive failure threshold before respawn. */
export const DEFAULT_TUNNEL_FAILURE_THRESHOLD = 3;

/** Per-ping timeout — fast enough to detect dead, slow enough not to false-positive. */
export const DEFAULT_TUNNEL_PING_TIMEOUT_MS = 5_000;

/** Where the tunnel state file lives. */
export const TUNNEL_STATE_FILE = join(homedir(), '.agenticmail', 'tunnel.json');

export interface TunnelWatchdogOptions {
  pingIntervalMs?: number;
  failureThreshold?: number;
  pingTimeoutMs?: number;
  /** Override for tests; defaults to console.* */
  onError?: (err: Error, context: string) => void;
  /** Override for tests / structured logging. */
  onEvent?: (event: TunnelWatchdogEvent) => void;
}

export type TunnelWatchdogEvent =
  | { kind: 'tunnel-healthy'; url: string }
  | { kind: 'tunnel-failed'; url: string; failures: number }
  | { kind: 'tunnel-dead'; url: string }
  | { kind: 'tunnel-respawned'; oldUrl: string; newUrl: string }
  | { kind: 'tunnel-respawn-failed'; oldUrl: string; reason: string }
  | { kind: 'tunnel-repointed'; agentId: string; oldUrl: string; newUrl: string };

export interface TunnelStateFile {
  pid: number;
  url: string;
  port: number;
  startedAt: string;
}

/**
 * Start the watchdog loop. Returns a stop function for clean shutdown.
 * Idempotent on the "no tunnel file" case — silently does nothing
 * when the install isn't using a quick-tunnel.
 */
export function startTunnelWatchdog(
  db: Db,
  config: AgenticMailConfig,
  options: TunnelWatchdogOptions = {},
): () => void {
  const pingMs = options.pingIntervalMs ?? DEFAULT_TUNNEL_PING_INTERVAL_MS;
  const threshold = options.failureThreshold ?? DEFAULT_TUNNEL_FAILURE_THRESHOLD;
  const timeoutMs = options.pingTimeoutMs ?? DEFAULT_TUNNEL_PING_TIMEOUT_MS;
  const onError = options.onError ?? ((err, ctx) => {
    // eslint-disable-next-line no-console
    console.error(`[tunnel-watchdog] ${ctx}: ${err.message}`);
  });
  const onEvent = options.onEvent ?? ((event) => {
    // eslint-disable-next-line no-console
    if (event.kind === 'tunnel-healthy') return; // too chatty
    console.log(`[tunnel-watchdog] ${event.kind}: ${JSON.stringify(event)}`);
  });

  let consecutiveFailures = 0;
  let respawnInFlight = false;
  // Lazy-construct the PhoneManager — only the dead-path needs it.
  // Saves an `db.exec(CREATE TABLE...)` hit on every boot when the
  // tunnel is healthy, and keeps the unit tests injectable.
  let phoneManager: PhoneManager | null = null;
  const getPhoneManager = (): PhoneManager => {
    if (!phoneManager) phoneManager = new PhoneManager(db as any, config.masterKey);
    return phoneManager;
  };

  const tick = async () => {
    if (respawnInFlight) return; // never overlap a respawn with a ping
    const state = readTunnelState();
    if (!state) return; // operator isn't using a quick-tunnel; nothing to watch

    const healthy = await pingTunnel(state.url, timeoutMs);
    if (healthy) {
      if (consecutiveFailures > 0) {
        // Transient — the tunnel recovered before we declared it dead.
        onEvent({ kind: 'tunnel-healthy', url: state.url });
        consecutiveFailures = 0;
      }
      return;
    }

    consecutiveFailures += 1;
    onEvent({ kind: 'tunnel-failed', url: state.url, failures: consecutiveFailures });
    if (consecutiveFailures < threshold) return;

    // Threshold tripped — respawn.
    respawnInFlight = true;
    try {
      onEvent({ kind: 'tunnel-dead', url: state.url });
      const oldUrl = state.url;
      const { state: newState, reason } = await respawnTunnel(state.port);
      if (!newState) {
        onEvent({ kind: 'tunnel-respawn-failed', oldUrl, reason: reason ?? 'unknown' });
        return;
      }
      writeTunnelState(newState);
      consecutiveFailures = 0;
      onEvent({ kind: 'tunnel-respawned', oldUrl, newUrl: newState.url });

      // Repoint every affected phone-transport. The Twilio API itself
      // doesn't store the webhook URL — Twilio reads our stored
      // webhookBaseUrl on every outbound /calls/start call AND sets the
      // resulting per-call Url at dial time. So updating our config is
      // enough; no Twilio API call needed.
      try {
        repointAffectedTransports(getPhoneManager(), oldUrl, newState.url, onEvent);
      } catch (err) {
        onError(err as Error, 'repoint-transports');
      }
    } catch (err) {
      onError(err as Error, 'respawn-tunnel');
    } finally {
      respawnInFlight = false;
    }
  };

  const handle = setInterval(() => { void tick(); }, pingMs);
  // Don't keep the process alive just for the watchdog.
  if (typeof (handle as any).unref === 'function') (handle as any).unref();

  return () => {
    try { clearInterval(handle); } catch { /* idempotent */ }
  };
}

/** Read + validate the on-disk state file. Returns null on absent / corrupt. */
function readTunnelState(): TunnelStateFile | null {
  try {
    if (!existsSync(TUNNEL_STATE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(TUNNEL_STATE_FILE, 'utf-8'));
    if (typeof parsed?.url !== 'string' || typeof parsed?.port !== 'number') return null;
    return parsed as TunnelStateFile;
  } catch { return null; }
}

function writeTunnelState(state: TunnelStateFile): void {
  try {
    mkdirSync(dirname(TUNNEL_STATE_FILE), { recursive: true });
    writeFileSync(TUNNEL_STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* best-effort */ }
}

/**
 * Health-ping the tunnel. We hit a path that the API server itself
 * answers — `/api/agenticmail/health` — so a 2xx proves the FULL round
 * trip (Cloudflare edge → tunnel → API → tunnel → Cloudflare edge → us).
 * Don't use the bare base URL; some Cloudflare edge configurations
 * return 200 for the root of a tunnel even when the upstream is gone.
 */
async function pingTunnel(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/agenticmail/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Spawn a fresh `cloudflared tunnel --url http://127.0.0.1:<port>` and
 * resolve to the new state once we see the URL in its stdout/stderr.
 * Resolves to null if cloudflared doesn't emit a URL within 30s.
 */
async function respawnTunnel(port: number): Promise<{ state: TunnelStateFile | null; reason?: string }> {
  const bin = resolveCloudflaredBinary();
  if (!bin) {
    return {
      state: null,
      reason: 'cloudflared binary not found (looked in ~/.agenticmail/bin, $PATH, /opt/homebrew/bin, /usr/local/bin, /usr/bin)',
    };
  }

  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--config', '/dev/null', '--url', `http://127.0.0.1:${port}`], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  return new Promise<{ state: TunnelStateFile | null; reason?: string }>((resolve) => {
    let resolved = false;
    const finish = (state: TunnelStateFile | null, reason?: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ state, reason });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      finish(null, 'cloudflared did not emit a URL within 30s');
    }, 30_000);
    const onChunk = (chunk: Buffer) => {
      const m = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m) {
        child.unref();
        finish({
          pid: child.pid ?? 0,
          url: m[0],
          port,
          startedAt: new Date().toISOString(),
        });
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => finish(null, `cloudflared spawn error: ${err.message}`));
    child.on('exit', (code) => finish(null, `cloudflared exited (code=${code}) before emitting a URL`));
  });
}

/**
 * Find the cloudflared binary — managed install first, then PATH, then
 * well-known package-manager install locations. The same resolution
 * order the CLI's `cmdTunnel` uses.
 *
 * Important on Apple Silicon: launchd / pm2 / forever-managed Node
 * processes often inherit a PATH that excludes `/opt/homebrew/bin`
 * (Homebrew-on-ARM's default install prefix). When the operator's
 * shell can find `cloudflared` but the API process can't, the watchdog
 * was previously stuck reporting "did not emit a URL within 30s"
 * because `spawn('')` exits immediately. The absolute-path fallbacks
 * below cover that case for both Apple Silicon (`/opt/homebrew/bin`)
 * and Intel mac / Linux (`/usr/local/bin`, `/usr/bin`).
 */
function resolveCloudflaredBinary(): string {
  const managed = join(homedir(), '.agenticmail', 'bin', 'cloudflared');
  if (existsSync(managed)) return managed;
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('which', ['cloudflared'], {
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (out) return out;
  } catch { /* not on PATH */ }
  // PATH-less fallbacks for daemon-launched API processes.
  for (const candidate of [
    '/opt/homebrew/bin/cloudflared',  // Homebrew on Apple Silicon
    '/usr/local/bin/cloudflared',     // Homebrew on Intel mac, manual installs
    '/usr/bin/cloudflared',           // apt/dnf system installs on Linux
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * For every phone-transport whose `webhookBaseUrl` matches `oldUrl`,
 * rewrite it to `newUrl`. The transport is encrypted at rest under
 * the master key; we have to round-trip through PhoneManager so the
 * validator runs and the encryption is preserved.
 */
function repointAffectedTransports(
  phoneManager: PhoneManager,
  oldUrl: string,
  newUrl: string,
  onEvent: (event: TunnelWatchdogEvent) => void,
): void {
  // Iterate via the lower-level scan that's already O(rows-with-
  // phoneTransport-metadata) since most agents won't have one
  // configured. Using `phoneManager.listAgentsWithPhone()` if it
  // exists, otherwise raw SQL.
  const rows = (phoneManager as any).db.prepare(
    "SELECT id FROM agents WHERE metadata LIKE '%phoneTransport%'",
  ).all() as Array<{ id: string }>;
  for (const row of rows) {
    const cfg = phoneManager.getPhoneTransportConfig(row.id);
    if (!cfg) continue;
    if (cfg.webhookBaseUrl !== oldUrl) continue;
    // Validate + save — the manager re-encrypts under the master key.
    const next = { ...cfg, webhookBaseUrl: newUrl };
    const validation = validatePhoneTransportProfile(next);
    if (!validation.ok) continue;
    phoneManager.savePhoneTransportConfig(row.id, next);
    onEvent({ kind: 'tunnel-repointed', agentId: row.id, oldUrl, newUrl });
  }
}
