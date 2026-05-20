/**
 * Classify the stderr of a failed `claude -p` child process into an
 * actionable, chat-friendly message we can forward to the operator
 * over Telegram. Mirrors the TypeScript `classifyClaudeChildError`
 * in agenticmail/src/anthropic-token.ts — kept as a parallel .mjs
 * file because bridge.mjs runs without a bundler and importing
 * compiled TS would require a build step the bridge intentionally
 * doesn't have.
 *
 * Pattern-match priority is deliberate: subscription-disabled and
 * quota errors are also `4xx` responses, so test for the specific
 * signals BEFORE the generic auth-failed match.
 */

const SUBSCRIPTION_DISABLED_RE = /subscription.*disabled|disabled.*subscription|claude code.*not.*authori[sz]ed/i;

/**
 * @param {string} stderr - the stderr text from a failed claude run
 * @returns {{ category: string, message: string }}
 */
export function classifyClaudeChildError(stderr) {
  const s = (stderr ?? '').toString();

  if (/rate[_ -]?limit|too many requests|429/i.test(s)) {
    return {
      category: 'rate-limited',
      message:
        '⏳ I\'ve hit Claude\'s rate limit for the moment. This usually clears '
        + 'within a minute or two. Send your message again and I\'ll pick it up.',
    };
  }
  if (/quota|usage limit|spending limit|credit limit/i.test(s)) {
    return {
      category: 'quota-exceeded',
      message:
        '💳 I\'ve hit my Anthropic usage / quota limit. Once it resets (usually '
        + 'the next billing window) I\'ll be back — or your operator can switch '
        + 'me to a different token with `agenticmail setup-anthropic`.',
    };
  }
  if (SUBSCRIPTION_DISABLED_RE.test(s)) {
    return {
      category: 'subscription-disabled',
      message:
        '🚫 My Claude Code subscription access is disabled by the organisation. '
        + 'The operator can re-enable it at console.anthropic.com, or switch me '
        + 'to an API key via `agenticmail setup-anthropic --api-key sk-ant-api03-...`.',
    };
  }
  if (/401|unauthori[sz]ed|invalid.*api.*key|invalid.*token|authentication/i.test(s)) {
    return {
      category: 'auth-failed',
      message:
        '🔒 My Anthropic token is rejected (revoked / wrong / expired). '
        + 'The operator can refresh it with `agenticmail setup-anthropic`.',
    };
  }
  if (/overloaded|503|service unavailable/i.test(s)) {
    return {
      category: 'overloaded',
      message: '🛠️ Anthropic\'s API is overloaded right now. Try again in a few minutes.',
    };
  }
  return {
    category: 'unknown',
    // Truncate raw stderr — at chat scale even a few KB looks wrong
    // and may leak internals; pull only the first non-empty line.
    message: `Something went wrong on my end: ${s.split('\n').find(l => l.trim())?.slice(0, 240) || 'unknown error'}`,
  };
}
