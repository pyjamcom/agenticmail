import {
  bridgeWakeLastSeenAgeMs,
  getOperatorEmail,
  loadHostSession,
  planBridgeWake,
  type BridgeMailContext,
  type HostSession,
} from '@agenticmail/core';

export const OPENCLAW_BRIDGE_NAME = 'openclaw';

export interface OpenClawBridgeIdentity {
  name?: string;
  email?: string;
}

export interface OpenClawBridgeWakeArgs {
  email: any;
  uid: number;
  runtime?: any;
  log?: any;
  inFlightUids?: Set<number>;
  nowMs?: number;
  loadSession?: () => HostSession | null;
}

export type OpenClawBridgeWakeOutcome =
  | { handled: true; action: 'duplicate'; uid: number }
  | { handled: true; action: 'skip-live'; uid: number; ageMs: number }
  | { handled: true; action: 'skip-untrusted'; uid: number }
  | { handled: true; action: 'escalate'; uid: number; reason: 'no-fresh-session' | 'wake-unavailable' }
  | { handled: true; action: 'wake-queued'; uid: number; sessionKey: string };

export function isOpenClawBridgeAccount(identity: OpenClawBridgeIdentity): boolean {
  const name = identity.name?.trim().toLowerCase() ?? '';
  const email = identity.email?.trim().toLowerCase() ?? '';
  return name === OPENCLAW_BRIDGE_NAME || email === `${OPENCLAW_BRIDGE_NAME}@localhost`;
}

export function buildOpenClawBridgeMailContext(email: any, uid: number): BridgeMailContext {
  const from = email?.from?.[0]?.address ?? 'unknown';
  const subject = email?.subject ?? '(no subject)';
  const body = email?.text ?? email?.html ?? '';
  return {
    bridgeName: OPENCLAW_BRIDGE_NAME,
    uid,
    from,
    subject,
    preview: String(body).slice(0, 600),
  };
}

export async function handleOpenClawBridgeWake(args: OpenClawBridgeWakeArgs): Promise<OpenClawBridgeWakeOutcome> {
  const { uid, inFlightUids } = args;
  if (inFlightUids?.has(uid)) {
    args.log?.warn?.(`[agenticmail] bridge wake duplicate skipped for UID ${uid}`);
    return { handled: true, action: 'duplicate', uid };
  }

  inFlightUids?.add(uid);
  try {
    const mail = buildOpenClawBridgeMailContext(args.email, uid);
    const session = args.loadSession ? args.loadSession() : loadHostSession('openclaw');
    const route = planBridgeWake({
      session,
      mail,
      nowMs: args.nowMs,
      operatorEmail: getOperatorEmail(),
      // OpenClaw bridge is openclaw@localhost; teammates share `localhost`.
      localDomains: ['localhost'],
    });

    if (route.action === 'skip-untrusted') {
      // Security gate (GHSA-fq4x-789w-jg5h / CWE-306): untrusted external
      // sender — never resume the operator's privileged session on attacker-
      // controlled mail. The message is still delivered to the inbox.
      args.log?.warn?.(`[agenticmail] bridge wake skipped; untrusted sender "${mail.from ?? '(unknown)'}" for UID ${uid}`);
      return { handled: true, action: 'skip-untrusted', uid };
    }

    if (route.action === 'skip-live') {
      args.log?.info?.(`[agenticmail] bridge wake skipped; operator live (lastSeen=${route.ageMs}ms)`);
      return { handled: true, action: 'skip-live', uid, ageMs: route.ageMs };
    }

    if (route.action === 'escalate') {
      args.log?.warn?.(`[agenticmail] bridge wake has no fresh OpenClaw host session for UID ${uid}`);
      return { handled: true, action: 'escalate', uid, reason: 'no-fresh-session' };
    }

    const enqueue = args.runtime?.system?.enqueueSystemEvent;
    if (typeof enqueue !== 'function') {
      const ageMs = bridgeWakeLastSeenAgeMs(route.session);
      args.log?.warn?.(`[agenticmail] bridge wake cannot enqueue system event for UID ${uid} (lastSeen=${ageMs ?? 'unknown'}ms)`);
      return { handled: true, action: 'escalate', uid, reason: 'wake-unavailable' };
    }

    await enqueue(route.prompt, { sessionKey: route.session.sessionId });
    args.log?.info?.(`[agenticmail] bridge wake queued for OpenClaw session ${route.session.sessionId}`);
    return { handled: true, action: 'wake-queued', uid, sessionKey: route.session.sessionId };
  } finally {
    inFlightUids?.delete(uid);
  }
}
