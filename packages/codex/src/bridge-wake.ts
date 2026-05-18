/**
 * Headless bridge-wake — resume the operator's Codex thread against
 * bridge-inbox mail without requiring a live interactive session.
 *
 * Direct counterpart to `packages/claudecode/src/bridge-wake.ts` —
 * see that file's docstring for the full rationale. The only
 * difference is which SDK call lights up the resumed turn:
 *
 *   - Claude Code: `query({ options: { resume: sessionId, … } })`
 *   - Codex:       `codex.resumeThread(threadId).run(prompt)`
 *
 * Codex's resume is more direct because `@openai/codex-sdk` exposes
 * a first-class `resumeThread(id)` factory that returns a Thread
 * object with the historical messages pre-loaded. The `.run()` call
 * picks up where the operator left off.
 */

import {
  bridgeWakeErrorMessage,
  classifyResumeError,
  type BridgeWakeResult,
} from '@agenticmail/core';
import type { AgenticMailAccount } from './types.js';

export interface BridgeWakeInput {
  bridge: AgenticMailAccount;
  /** Codex thread id from the saved host session. */
  sessionId: string;
  cwd?: string;
  prompt: string;
  /** Codex sandboxMode + approvalPolicy mirror the dispatcher's
   *  normal worker spawn so the resumed turn has the same shape. */
  sandboxMode?: 'workspace-write' | 'read-only' | 'danger-full-access';
  approvalPolicy?: 'never' | 'on-request' | 'untrusted';
  timeoutMs?: number;
}

/**
 * Resume the operator's Codex thread headlessly. The SDK is imported
 * lazily so the dispatcher can survive on a machine where Codex was
 * uninstalled mid-session — we degrade gracefully to "sdk-missing"
 * and the dispatcher escalates via SMS.
 */
export async function resumeBridgeThread(
  input: BridgeWakeInput,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): Promise<BridgeWakeResult> {
  const startMs = Date.now();
  const timeoutMs = input.timeoutMs ?? 5 * 60 * 1000;

  let sdk: typeof import('@openai/codex-sdk');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdk = await import('@openai/codex-sdk' as any) as typeof import('@openai/codex-sdk');
  } catch (err) {
    const msg = bridgeWakeErrorMessage(err);
    log('warn', `[bridge-wake] @openai/codex-sdk not available: ${msg.slice(0, 200)}`);
    return { ok: false, error: 'sdk-missing', errorMessage: msg, durationMs: Date.now() - startMs };
  }

  try {
    log('info', `[bridge-wake] resuming Codex thread ${input.sessionId.slice(0, 8)}… for ${input.bridge.name}`);
    const codex = new sdk.Codex({});
    // Codex CLI refuses to exec in any directory that isn't a known
    // trusted workspace — under pm2 our cwd is usually /Users/<user>
    // (the launchd default), which is NOT in Codex's trust list. The
    // failure surfaces as:
    //   Codex Exec exited with code 1: Reading prompt from stdin...
    //   Not inside a trusted directory and --skip-git-repo-check was not specified.
    // and every bridge-wake fired turn into a silent no-op.
    //
    // Fix: opt out of the git-repo check (we're not running in a repo;
    // we're resuming a session against bridge mail) AND pin the
    // working directory to whatever the operator's host-session
    // recorded as their last cwd. If we didn't capture one, fall
    // back to $HOME so the spawn at least has a stable, real path.
    const threadOptions: import('@openai/codex-sdk').ThreadOptions = {
      skipGitRepoCheck: true,
      workingDirectory: input.cwd || process.env.HOME || process.cwd(),
      ...(input.sandboxMode ? { sandboxMode: input.sandboxMode } : {}),
      ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
    };
    const thread = codex.resumeThread(input.sessionId, threadOptions);

    // Spawn the resumed turn against the same workspace the operator
    // last had open — so file writes land in the right project tree
    // and shell commands run with the right cwd context.
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
    (timeoutHandle as unknown as { unref?: () => void }).unref?.();

    let assistantText = '';
    let timedOut = false;
    try {
      const streamed = await thread.runStreamed(input.prompt, {
        signal: abortController.signal,
      } as Parameters<typeof thread.runStreamed>[1]);
      for await (const event of streamed.events as AsyncIterable<unknown>) {
        const e = event as { type?: string; item?: { type?: string; text?: string }; data?: { text?: string } };
        // Capture the last assistant text frame for the log line.
        if (e.type === 'item.completed' && e.item?.type === 'assistant_message' && e.item.text) {
          assistantText = e.item.text;
        }
      }
    } catch (err) {
      // Abort surfaces as an AbortError — treat as timeout.
      if ((err as Error)?.name === 'AbortError') timedOut = true;
      else throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (timedOut) {
      log('warn', `[bridge-wake] timeout after ${timeoutMs}ms — bridge wake gave up`);
      return { ok: false, error: 'timeout', durationMs: Date.now() - startMs };
    }

    const result: BridgeWakeResult = { ok: true, text: assistantText, durationMs: Date.now() - startMs };
    log('info', `[bridge-wake] resumed thread ok (${result.durationMs}ms, ${assistantText.length} chars)`);
    return result;
  } catch (err) {
    const msg = bridgeWakeErrorMessage(err);
    const error = classifyResumeError(err, { sdkMissingMarkers: [] });
    log('warn', `[bridge-wake] resume failed (${error}): ${msg.slice(0, 200)}`);
    return { ok: false, error, errorMessage: msg, durationMs: Date.now() - startMs };
  }
}
