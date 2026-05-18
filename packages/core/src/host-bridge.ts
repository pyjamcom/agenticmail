import type { HostSession } from './host-sessions.js';

export type BridgeWakeError = 'session-expired' | 'sdk-missing' | 'timeout' | 'other';

export interface BridgeWakeResult {
  ok: boolean;
  text?: string;
  error?: BridgeWakeError;
  errorMessage?: string;
  durationMs?: number;
}

export interface BridgeWakePromptArgs {
  bridgeName: string;
  uid: number;
  subject?: string;
  from?: string;
  preview?: string;
}

export interface BridgeMailContext extends BridgeWakePromptArgs {}

export type BridgeWakeRoute =
  | {
      action: 'skip-live';
      reason: 'operator-live';
      ageMs: number;
      mail: BridgeMailContext;
    }
  | {
      action: 'escalate';
      reason: 'no-fresh-session';
      mail: BridgeMailContext;
    }
  | {
      action: 'resume';
      session: HostSession;
      prompt: string;
      mail: BridgeMailContext;
    };

export interface PlanBridgeWakeArgs {
  session: HostSession | null;
  mail: BridgeMailContext;
  nowMs?: number;
  liveWindowMs?: number;
}

export interface ResumeErrorClassificationOptions {
  expiredMarkers?: readonly string[];
  sdkMissingMarkers?: readonly string[];
}

export const BRIDGE_OPERATOR_LIVE_WINDOW_MS = 30_000;

const DEFAULT_EXPIRED_MARKERS = [
  'session not found',
  'invalid session',
  'session expired',
  'no such session',
  'unknown session',
  'thread not found',
  'invalid thread',
  'thread expired',
  'no such thread',
  'unknown thread',
] as const;

const DEFAULT_SDK_MISSING_MARKERS = [
  'cannot find module',
  'could not be found',
  'command not found',
] as const;

export function bridgeWakeErrorMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

export function classifyResumeError(
  err: unknown,
  options: ResumeErrorClassificationOptions = {},
): BridgeWakeError {
  const msg = bridgeWakeErrorMessage(err).toLowerCase();
  const expiredMarkers = options.expiredMarkers ?? DEFAULT_EXPIRED_MARKERS;
  const sdkMissingMarkers = options.sdkMissingMarkers ?? DEFAULT_SDK_MISSING_MARKERS;
  if (expiredMarkers.some((marker) => msg.includes(marker))) return 'session-expired';
  if (sdkMissingMarkers.some((marker) => msg.includes(marker))) return 'sdk-missing';
  return 'other';
}

export function bridgeWakeLastSeenAgeMs(
  session: Pick<HostSession, 'lastSeenMs'> | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!session) return null;
  return nowMs - session.lastSeenMs;
}

export function shouldSkipBridgeWakeForLiveOperator(
  session: Pick<HostSession, 'lastSeenMs'> | null | undefined,
  nowMs = Date.now(),
  liveWindowMs = BRIDGE_OPERATOR_LIVE_WINDOW_MS,
): boolean {
  const ageMs = bridgeWakeLastSeenAgeMs(session, nowMs);
  return ageMs !== null && ageMs < liveWindowMs;
}

export function planBridgeWake(args: PlanBridgeWakeArgs): BridgeWakeRoute {
  const nowMs = args.nowMs ?? Date.now();
  const liveWindowMs = args.liveWindowMs ?? BRIDGE_OPERATOR_LIVE_WINDOW_MS;
  const ageMs = bridgeWakeLastSeenAgeMs(args.session, nowMs);
  if (ageMs !== null && ageMs < liveWindowMs) {
    return {
      action: 'skip-live',
      reason: 'operator-live',
      ageMs,
      mail: args.mail,
    };
  }
  if (!args.session) {
    return {
      action: 'escalate',
      reason: 'no-fresh-session',
      mail: args.mail,
    };
  }
  return {
    action: 'resume',
    session: args.session,
    prompt: composeBridgeWakePrompt(args.mail),
    mail: args.mail,
  };
}

/**
 * Build the prompt a host session sees on bridge wake. Host adapters
 * keep their own SDK resume call, but share this operator-facing
 * instruction shape so Claude Code, Codex, OpenClaw and later hosts
 * do not drift semantically.
 */
export function composeBridgeWakePrompt(args: BridgeWakePromptArgs): string {
  const subject = args.subject ?? '(no subject)';
  const from = args.from ?? 'unknown';
  const preview = (args.preview ?? '').slice(0, 600);
  return [
    `🎀 Bridge mail arrived — headless wake.`,
    '',
    `You are being resumed against your last session because new mail landed in your bridge inbox (${args.bridgeName}@localhost) and you weren't actively at the keyboard.`,
    '',
    `Trigger:`,
    `  UID:     ${args.uid}`,
    `  From:    ${from}`,
    `  Subject: ${subject}`,
    `  Preview: ${preview}`,
    '',
    `Read it with mcp__agenticmail__read_email({ uid: ${args.uid} }) and decide:`,
    `  · Does it need a reply from YOU (the operator's session)? Reply via mcp__agenticmail__reply_email.`,
    `  · Does it need a teammate to act? Forward / re-route by replying with wake: ["<teammate>"].`,
    `  · Is it [NEEDS OPERATOR] / [BLOCKED]? Then it's actually for the human — mark it unread, and the operator will see it on their next keystroke.`,
    `  · Is it FYI noise? mark_read and exit.`,
    '',
    `Keep this turn SHORT. You're being resumed to handle ONE piece of mail, not to continue the prior conversation.`,
  ].join('\n');
}
