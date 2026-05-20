/**
 * Anthropic-token utilities — validate a token against the live API
 * + classify error responses into actionable categories.
 *
 * Why a dedicated module: token validation isn't "did the string
 * parse?". A token can have the right shape (sk-ant-oat01-... or
 * sk-ant-api03-...) and still be revoked, scoped to a different
 * organisation, expired, or rate-limited at the source. The only
 * way to know is to actually call Anthropic. We need that callable
 * from THREE places (the new `setup-anthropic` save flow, the
 * Telegram bridge's startup health check, the claudecode dispatcher's
 * env-var sanity check), so factor the network call + classification
 * once.
 *
 * No SDK dependency: we call /v1/messages directly with fetch. The
 * Anthropic SDK adds ~150 KB of weight to the cli for one HTTP
 * request, which is the wrong trade for an early-boot validator.
 */

/** Format identification — guides which auth header to send. */
export type AnthropicTokenKind = 'oauth' | 'api-key' | 'unknown';

/** Recognise the two token formats Anthropic issues today. */
export function identifyTokenKind(token: string): AnthropicTokenKind {
  if (typeof token !== 'string') return 'unknown';
  const t = token.trim();
  if (t.startsWith('sk-ant-oat01-')) return 'oauth';
  if (t.startsWith('sk-ant-api03-') || t.startsWith('sk-ant-')) return 'api-key';
  return 'unknown';
}

/** Result of a live-validation call against Anthropic. */
export interface TokenValidationResult {
  /** `true` only when Anthropic returned a 200 + a usable response. */
  ok: boolean;
  /** Short classification suitable for branching error UX. */
  reason:
    | 'ok'
    | 'invalid-format'
    | 'auth-failed'            // 401 — bad token, revoked, wrong org scope
    | 'forbidden'              // 403 — org policy blocked, quota gating
    | 'rate-limited'           // 429 — temporary; retry later
    | 'subscription-disabled'  // org has Claude Code subscription disabled
    | 'server-error'           // 5xx — Anthropic-side hiccup, not the token
    | 'network'                // fetch threw; DNS / TLS / offline
    | 'unknown';
  /** Human-readable error suitable for showing in a wizard. */
  message: string;
  /** HTTP status when the call reached Anthropic. */
  httpStatus?: number;
  /** Underlying Anthropic error code, when present. */
  anthropicErrorType?: string;
}

/**
 * Patterns Anthropic uses in 4xx/429 bodies to signal that the
 * organisation has Claude Code subscription access disabled, even
 * though the OAuth token itself is valid. This is the exact failure
 * mode v0.9.76 documented: subscription-routed paths fail; bearer-
 * routed `/v1/messages` may still work. Catching this distinct from
 * a generic auth failure lets the wizard surface the right fix
 * ("ask org admin to re-enable, OR switch to an API key").
 */
const SUBSCRIPTION_DISABLED_RE = /subscription.*disabled|disabled.*subscription|claude code.*not.*authori[sz]ed/i;

/**
 * Live-validate the token by issuing the cheapest possible
 * `/v1/messages` call: model = haiku, `max_tokens: 1`,
 * input "hi". The actual content is irrelevant; we only care about
 * the response code + auth-error classification.
 *
 * Cost: one Haiku token in, one out — effectively free, and the
 * call completes in <500ms on a healthy network.
 *
 * Times out at 8s — well under the wizard's patience but generous
 * enough that a slow corporate proxy gets a fair shot.
 */
export async function validateAnthropicToken(
  token: string,
  opts: { timeoutMs?: number } = {},
): Promise<TokenValidationResult> {
  const trimmed = (token ?? '').trim();
  const kind = identifyTokenKind(trimmed);
  if (!trimmed) {
    return { ok: false, reason: 'invalid-format', message: 'No token provided.' };
  }
  if (kind === 'unknown') {
    return {
      ok: false,
      reason: 'invalid-format',
      message: 'Token does not match Anthropic\'s format (expected `sk-ant-oat01-...` or `sk-ant-api03-...`).',
    };
  }

  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  // OAuth tokens use the Bearer scheme; API keys use the x-api-key
  // header. The two are mutually exclusive — sending both confuses
  // the gateway and trips a 400 even on otherwise valid tokens.
  if (kind === 'oauth') {
    headers['authorization'] = `Bearer ${trimmed}`;
    // OAuth tokens additionally require a beta header that whitelists
    // them for the messages endpoint. Without it the API returns 400
    // "missing required beta header" — looks like a token failure but
    // isn't.
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  } else {
    headers['x-api-key'] = trimmed;
  }

  // Pick the cheapest current Anthropic model for the probe. Using a
  // fixed string here rather than the operator's configured model
  // keeps validation deterministic — a wrong / typo'd model would
  // surface as a token failure otherwise.
  const body = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });

  const timeoutMs = opts.timeoutMs ?? 8_000;
  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'network',
      message: `Could not reach api.anthropic.com: ${(err as Error).message}`,
    };
  }

  if (response.ok) {
    return { ok: true, reason: 'ok', message: 'Token is valid.', httpStatus: response.status };
  }

  // Read the body once — Anthropic returns JSON with an `error.type`
  // and `error.message` for every 4xx/5xx. We surface both verbatim
  // so the wizard can show the operator what Anthropic actually said.
  let bodyText = '';
  try { bodyText = await response.text(); } catch { /* leave empty */ }
  let parsed: any = {};
  try { parsed = bodyText ? JSON.parse(bodyText) : {}; } catch { /* leave empty */ }
  const anthropicErrorType = typeof parsed?.error?.type === 'string' ? parsed.error.type : undefined;
  const anthropicMessage = typeof parsed?.error?.message === 'string' ? parsed.error.message : bodyText.slice(0, 240);

  // Subscription-disabled detection runs BEFORE the generic 4xx/5xx
  // fan-out: the org-policy error has shown up as both 401 and 403
  // in production, depending on the route, and the distinct branch
  // gives the wizard a precise actionable message.
  if (SUBSCRIPTION_DISABLED_RE.test(anthropicMessage)) {
    return {
      ok: false,
      reason: 'subscription-disabled',
      message:
        'Your organisation has disabled Claude Code subscription access for this token. '
        + 'Ask the org admin to re-enable it, or use a `sk-ant-api03-...` API key instead.',
      httpStatus: response.status,
      anthropicErrorType,
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      reason: 'auth-failed',
      message:
        anthropicMessage
        || 'Authentication failed. The token is invalid, revoked, or scoped to a different organisation.',
      httpStatus: 401,
      anthropicErrorType,
    };
  }
  if (response.status === 403) {
    return {
      ok: false,
      reason: 'forbidden',
      message:
        anthropicMessage
        || 'Anthropic refused the call (org permission / quota gating).',
      httpStatus: 403,
      anthropicErrorType,
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      reason: 'rate-limited',
      message:
        anthropicMessage
        || 'Rate-limited. Wait a minute and try again.',
      httpStatus: 429,
      anthropicErrorType,
    };
  }
  if (response.status >= 500) {
    return {
      ok: false,
      reason: 'server-error',
      message:
        anthropicMessage
        || `Anthropic returned ${response.status} — not the token\'s fault. Try again in a minute.`,
      httpStatus: response.status,
      anthropicErrorType,
    };
  }
  return {
    ok: false,
    reason: 'unknown',
    message: anthropicMessage || `Unexpected response (HTTP ${response.status}).`,
    httpStatus: response.status,
    anthropicErrorType,
  };
}

/**
 * Tightly-scoped classifier reused by the Telegram bridge's error
 * path. The bridge spawns `claude -p` and the child prints whatever
 * error it hit to stderr; we string-match the most common Anthropic-
 * side failure signals so we can give the human on the other end of
 * the chat an actionable explanation instead of "claude exited code=1".
 *
 * Returns a Telegram-friendly message AND a category so the bridge
 * can decide whether to retry, queue, or surface — separate from
 * the message text itself.
 */
export interface ChildErrorClassification {
  category:
    | 'rate-limited'
    | 'quota-exceeded'
    | 'subscription-disabled'
    | 'auth-failed'
    | 'overloaded'
    | 'unknown';
  /** Message safe to forward verbatim to the operator in chat. */
  message: string;
}

export function classifyClaudeChildError(stderr: string): ChildErrorClassification {
  const s = (stderr ?? '').toString();

  // Rate-limit / quota — the bridge sees these in the wild when the
  // operator's session burns through the per-minute or per-hour cap.
  if (/rate[_ -]?limit|too many requests|429/i.test(s)) {
    return {
      category: 'rate-limited',
      message:
        '⏳ I\'ve hit Claude\'s rate limit for the moment. This usually clears within a minute or two. '
        + 'Send your message again and I\'ll pick it up.',
    };
  }
  if (/quota|usage limit|spending limit|credit limit/i.test(s)) {
    return {
      category: 'quota-exceeded',
      message:
        '💳 I\'ve hit my Anthropic usage / quota limit. Once it resets (usually next billing window) '
        + 'I\'ll be back — or your operator can switch me to a different token with `agenticmail setup-anthropic`.',
    };
  }
  // Org-policy disabling, same pattern as the validator.
  if (SUBSCRIPTION_DISABLED_RE.test(s)) {
    return {
      category: 'subscription-disabled',
      message:
        '🚫 My Claude Code subscription access is disabled by the organisation. '
        + 'The operator can re-enable it at console.anthropic.com, or switch me to an API key '
        + 'via `agenticmail setup-anthropic --api-key sk-ant-api03-...`.',
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
      message:
        '🛠️ Anthropic\'s API is overloaded right now. Try again in a few minutes.',
    };
  }
  return {
    category: 'unknown',
    // Truncate raw stderr — at chat scale even a few KB looks wrong
    // and may leak internals; pull only the first line.
    message: `Something went wrong on my end: ${s.split('\n')[0].slice(0, 240) || 'unknown error'}`,
  };
}
