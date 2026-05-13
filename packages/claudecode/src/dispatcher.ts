/**
 * AgenticMail → Claude Code event dispatcher.
 *
 * Long-lived daemon that bridges AgenticMail's event stream to the
 * Claude Agent SDK. Concretely: subscribes to the master API's SSE
 * stream for every AgenticMail account, and when an event arrives —
 * either a new mail in some agent's inbox, or a task assigned to some
 * agent — it spawns a Claude-powered worker that *is* that agent (same
 * persona, same `_account`-scoped MCP toolbelt) and lets it handle the
 * trigger.
 *
 * This is what makes "send an email to fola@localhost and she wakes up
 * and replies" work — without any always-on enterprise runtime, and
 * without an interactive Claude Code session having to be open.
 *
 * # Design notes
 *
 *   - One SSE connection per account (the master API does not currently
 *     expose a master-key "watch everything" endpoint). The dispatcher
 *     polls `GET /accounts` every `accountSyncIntervalMs` to discover
 *     newly-created accounts and tear down ones that disappeared, so
 *     `create_account` is wake-able within ~one sync interval with zero
 *     manual steps.
 *
 *   - Workers are spawned via `@anthropic-ai/claude-agent-sdk`'s
 *     `query()` — same OAuth as the user's `claude`, same MCP server,
 *     same persona prompt as the on-disk `.md`. Each worker drains its
 *     query stream to completion, then exits.
 *
 *   - Concurrency is capped via a small semaphore (default 10). Beyond
 *     that, wakes queue. This is a hard floor on Anthropic-side cost:
 *     50 simultaneous wakes = 50 simultaneous Claude calls, which the
 *     user is unlikely to want by default.
 *
 *   - Task events get an explicit "claim + submit_result" instruction
 *     in the wake prompt so the call_agent long-poll on the master API
 *     resolves cleanly. Mail events just say "you've got new mail" and
 *     trust the persona to do the right thing (read / reply / archive).
 */

import type { AgenticMailAccount } from './types.js';
import { resolveConfig, type ResolveConfigOptions } from './config.js';
import { listAccounts } from './api.js';
import { loadPersonaForAgent } from './persona-loader.js';

/** Event shape we accept off the SSE stream. */
interface SSEEvent {
  type?: string;
  uid?: number;
  from?: string;
  /**
   * Subject MAY appear at top-level on some code paths AND nested under
   * `message.subject` on others (the master API enriches new-mail events
   * with the full IMAP envelope, which lands under `message`). Always use
   * `extractSubject(event)` rather than reading either path directly.
   */
  subject?: string;
  message?: { subject?: string; from?: unknown; to?: unknown; messageId?: string };
  taskId?: string;
  taskType?: string;
  task?: string;
  assignee?: string;
  [key: string]: unknown;
}

/**
 * Read the subject from a new-mail SSE event regardless of which path
 * the master API put it on. Returns undefined if no subject is present.
 *
 * Why this exists: the master API's events.ts route handler enriches
 * the InboxWatcher 'new' event with the full IMAP envelope under
 * `event.message`. On some code paths (relay-classified mail, spam-
 * scored mail, the early-return for internal mail) the subject also
 * gets copied to top-level. We've seen BOTH shapes in production —
 * `event.subject` AND `event.message.subject` — so just check both.
 */
function extractSubject(event: SSEEvent): string | undefined {
  if (typeof event.subject === 'string') return event.subject;
  if (event.message && typeof event.message.subject === 'string') return event.message.subject;
  return undefined;
}

/** Same idea for `from`, used by the wake prompt. */
function extractFrom(event: SSEEvent): string | undefined {
  if (typeof event.from === 'string') return event.from;
  if (event.message && Array.isArray(event.message.from)) {
    const first = (event.message.from as Array<{ address?: string; name?: string }>)[0];
    if (first?.address) return first.address;
    if (first?.name) return first.name;
  }
  return undefined;
}

export interface DispatcherOptions extends ResolveConfigOptions {
  /** Max concurrent workers. Default 10. Hard floor on Anthropic cost. */
  maxConcurrentWorkers?: number;
  /** How often to re-poll /accounts for new agents. Default 60s. */
  accountSyncIntervalMs?: number;
  /** How long to wait between SSE reconnect attempts (start). Default 2s. */
  sseReconnectBaseMs?: number;
  /** Max backoff between SSE reconnect attempts. Default 60s. */
  sseReconnectMaxMs?: number;
  /** Override the Claude Agent SDK `query` function. Used by tests. */
  querySdk?: QueryFn;
  /** Override the global `fetch`. Used by tests. */
  fetchImpl?: typeof fetch;
  /** Override the global EventSource. Optional — we don't use EventSource
   *  by default (fetch + reader is simpler). */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** Minimal Claude Agent SDK query signature we use. */
export interface QueryFn {
  (params: { prompt: string; options?: Record<string, unknown> }): AsyncIterable<unknown>;
}

interface ChannelState {
  /** Account currently watched on this channel. */
  account: AgenticMailAccount;
  /** Active AbortController for the SSE fetch. */
  controller: AbortController | null;
  /** True once the channel has been instructed to stop permanently. */
  stopping: boolean;
  /** Current reconnect backoff in ms. */
  backoffMs: number;
  /** UIDs we've already woken on (per channel). Bounded — see below. */
  seenUids: Set<number>;
  /** Task IDs we've already started a worker for. Bounded. */
  seenTaskIds: Set<string>;
  /**
   * Cross-channel-type dedup: when /tasks/rpc and /tasks/assign fire, the
   * master API simultaneously (a) emits a task SSE event AND (b) sends a
   * `[RPC] …` / `[Task] …` notification email to the assignee. We get
   * BOTH from our per-agent SSE — same logical wake, double the worker
   * cost. We track the last time a task wake happened on this channel;
   * if a notification-shaped mail arrives within the suppression window,
   * we drop it.
   *
   * The window is bounded so we still recover when the dispatcher
   * reconnects after a drop and misses the task event — in that case
   * the notification email IS our only signal and must wake the worker.
   */
  suppressTaskMailUntilMs: number;
}

/** Defensive cap so seenUids/seenTaskIds can't grow unbounded over weeks. */
const SEEN_CAP = 1024;
function rememberBounded<T>(set: Set<T>, item: T): void {
  set.add(item);
  if (set.size > SEEN_CAP) {
    // Drop the oldest ~half. Set iteration order is insertion order.
    const drop = Array.from(set).slice(0, Math.floor(SEEN_CAP / 2));
    for (const x of drop) set.delete(x);
  }
}

const DEFAULT_MAX_CONCURRENT = 10;
// Was 60s. Dropped to 5s so an agent created mid-session via MCP
// `create_account` gets an SSE channel within seconds — otherwise the
// caller's `call_agent` / `send_email` to a brand-new agent will hang
// for up to a minute before any worker is awake to drain it. The
// /accounts call is cheap (one HTTP GET, small JSON).
const DEFAULT_SYNC_INTERVAL_MS = 5_000;
const DEFAULT_RECONNECT_BASE_MS = 2_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;

/**
 * How long after a task wake do we suppress the matching notification
 * email. 30s is generous — the API sends the notification synchronously
 * within milliseconds of the task event, but mail delivery can hop
 * through Stalwart's queue with a few seconds of latency under load.
 *
 * After this window expires, any inbound `[RPC] / [Task] / [Async-RPC]`
 * mail wakes the agent as a normal new-mail trigger — which is what we
 * want for the post-reconnect recovery case.
 */
const TASK_MAIL_SUPPRESS_WINDOW_MS = 30_000;

/**
 * Subject prefixes the master API uses for task-notification emails.
 * Matching is case-insensitive on the prefix only (the rest of the
 * subject contains the task description / type).
 */
const TASK_NOTIFICATION_SUBJECT_PREFIXES = ['[RPC]', '[Task]', '[Async-RPC]'];

function isTaskNotificationSubject(subject: string | undefined): boolean {
  if (!subject) return false;
  const head = subject.trimStart();
  for (const prefix of TASK_NOTIFICATION_SUBJECT_PREFIXES) {
    if (head.toLowerCase().startsWith(prefix.toLowerCase())) return true;
  }
  return false;
}

/**
 * Spawn-and-wait for a worker via the Claude Agent SDK.
 * Drains the query stream, captures the final assistant text, returns it.
 */
async function runWorker(
  query: QueryFn,
  persona: string,
  userPrompt: string,
  agent: AgenticMailAccount,
  mcpServerName: string,
  mcpCommand: string,
  mcpArgs: string[],
  mcpEnv: Record<string, string>,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
  abortSignal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const opts: Record<string, unknown> = {
    systemPrompt: persona,
    mcpServers: {
      [mcpServerName]: {
        command: mcpCommand,
        args: mcpArgs,
        env: mcpEnv,
      },
    },
    // Restrict to MCP tools only — workers should never reach for
    // Bash / Read / Edit / etc. Listing them avoids accidental leakage.
    allowedTools: [
      `mcp__${mcpServerName}__whoami`,
      `mcp__${mcpServerName}__list_inbox`,
      `mcp__${mcpServerName}__read_email`,
      `mcp__${mcpServerName}__send_email`,
      `mcp__${mcpServerName}__reply_email`,
      `mcp__${mcpServerName}__search_emails`,
      `mcp__${mcpServerName}__list_agents`,
      `mcp__${mcpServerName}__message_agent`,
      `mcp__${mcpServerName}__call_agent`,
      `mcp__${mcpServerName}__wait_for_email`,
      `mcp__${mcpServerName}__check_tasks`,
      `mcp__${mcpServerName}__claim_task`,
      `mcp__${mcpServerName}__submit_result`,
      `mcp__${mcpServerName}__request_tools`,
      `mcp__${mcpServerName}__invoke`,
    ],
    permissionMode: 'bypassPermissions' as const,
    abortController: abortSignal ? wrapSignal(abortSignal) : undefined,
  };

  const collectedText: string[] = [];
  try {
    for await (const msg of query({ prompt: userPrompt, options: opts })) {
      const m = msg as Record<string, unknown>;
      // We don't need to render messages — just capture final assistant text
      // for the dispatcher's log. The actual side effects (MCP tool calls
      // sending mail / submitting task results) happen during iteration.
      if (m.type === 'assistant' && Array.isArray(m.message && (m.message as { content?: unknown[] }).content)) {
        for (const block of (m.message as { content: unknown[] }).content) {
          const b = block as { type?: string; text?: string };
          if (b.type === 'text' && typeof b.text === 'string') collectedText.push(b.text);
        }
      }
      // Final result message (SDK emits one when the turn ends).
      if (m.type === 'result' && typeof (m as { result?: string }).result === 'string') {
        collectedText.push((m as { result: string }).result);
      }
    }
    const text = collectedText.join('\n').trim();
    log('info', `[dispatcher] worker for "${agent.name}" finished (${text.length} chars output)`);
    return { ok: true, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `[dispatcher] worker for "${agent.name}" failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

/** AbortController wrapper that bridges an AbortSignal in. */
function wrapSignal(signal: AbortSignal): AbortController {
  const c = new AbortController();
  if (signal.aborted) c.abort();
  else signal.addEventListener('abort', () => c.abort(), { once: true });
  return c;
}

/** Build the wake prompt for a new-mail trigger. */
function newMailPrompt(agent: AgenticMailAccount, event: SSEEvent): string {
  const from = extractFrom(event) ?? 'unknown sender';
  const subject = extractSubject(event) ?? '(no subject)';
  const uid = event.uid;
  return [
    `You have new mail.`,
    ``,
    `- From: ${from}`,
    `- Subject: ${subject}`,
    uid ? `- UID: ${uid}` : '',
    ``,
    `## Thread-aware coordination protocol`,
    ``,
    `You are ${agent.name}. Multiple agents may be CC'd on the same thread —`,
    `that is intentional: a thread is the shared workspace, and turn-taking is`,
    `implicit from context (who was addressed last, whose stage of the workflow`,
    `is next, who was @mentioned). Follow these steps in order:`,
    ``,
    `1. **Read this message.** read_email({ uid: ${uid ?? '<uid>'}, _account: "${agent.name}" }).`,
    ``,
    `2. **If this is a reply (Subject starts with "Re:" or an In-Reply-To header is present), load the rest of the thread.**`,
    `   Use search_emails({ subject: "<core subject without Re:>", _account: "${agent.name}" })`,
    `   to surface earlier messages in the thread, then read_email each prior UID.`,
    `   You MUST read the full thread before deciding what to do.`,
    ``,
    `3. **Identify the participants.** Look at To + CC across the thread. Those`,
    `   are your collaborators. Their names map to AgenticMail agents at`,
    `   <name>@localhost. They will each be woken on every reply-all the same way you were.`,
    ``,
    `4. **Decide: is it MY turn?** Yes if any of:`,
    `     - The latest message addresses you by name ("Vesper, please …", "@${agent.name} …").`,
    `     - The previous-stage handoff is to your role (e.g. designer → developer, and you are the developer).`,
    `     - You were directly asked a question and nobody has answered yet.`,
    `   No if:`,
    `     - The current ask is targeted at a teammate (their turn, not yours).`,
    `     - You have nothing substantive to add right now.`,
    `   When in doubt, stay silent — over-replying creates noise. Better to let`,
    `   the right teammate take the turn than to step on theirs.`,
    ``,
    `5. **If it's your turn — reply-all so the whole thread sees it.**`,
    `   reply_email({ uid: ${uid ?? '<uid>'}, replyAll: true, text: "...", _account: "${agent.name}" })`,
    `   Sign with your name. Be substantive but concise. If you are handing off`,
    `   to the next teammate, name them explicitly in your reply ("Orion — over to you, please …").`,
    ``,
    `6. **If you need additional help from a teammate not yet on the thread,**`,
    `   include them by CC'ing in your reply-all — DO NOT spin up a separate`,
    `   call_agent / message_agent side-channel. The thread is the workspace;`,
    `   everyone stays in context.`,
    ``,
    `7. **If it's NOT your turn,** mark the message read with mark_read and return.`,
    `   Do not reply just to acknowledge. Silence IS a valid contribution.`,
    ``,
    `When you finish, return a one-line summary of what you did:`,
    `  "Contributed: <one-line description>"  OR  "Stayed silent — not my turn."`,
    ``,
    `## Fallback for non-thread mail`,
    ``,
    `If this is a fresh standalone email (not part of a thread, only addressed`,
    `to you), handle it directly: answer the question, do the work, reply.`,
    `Spam: trust the auto-filter unless something obviously slipped through.`,
  ].filter(Boolean).join('\n');
}

/** Build the wake prompt for a task-assignment trigger. */
function taskPrompt(agent: AgenticMailAccount, event: SSEEvent): string {
  const taskId = event.taskId ?? '(missing taskId)';
  const taskText = event.task ?? '(no task description)';
  const taskType = event.taskType ?? 'generic';
  const from = event.from ?? 'unknown';
  return [
    `You have a pending task — handle it now.`,
    ``,
    `- Task ID: ${taskId}`,
    `- Type: ${taskType}`,
    `- From: ${from}`,
    `- Task: ${taskText}`,
    ``,
    `Workflow:`,
    `  1. Call claim_task({ id: "${taskId}", _account: "${agent.name}" }) to mark yourself as the owner.`,
    `  2. Do the work using whatever pre-loaded or invoke-able MCP tools fit.`,
    `  3. Call submit_result({ id: "${taskId}", result: { ... }, _account: "${agent.name}" }) with structured JSON.`,
    `     The caller is waiting on a synchronous long-poll — submit_result is what wakes them.`,
    ``,
    `If you cannot complete the task, submit_result with { status: "failed", reason: "..." }. Never leave it unclaimed — that strands the caller until timeout.`,
  ].join('\n');
}

/**
 * The dispatcher itself. Construct once, call .start() to begin watching,
 * .stop() to tear down. Returns when stop() has finished cleaning up.
 */
export class Dispatcher {
  private cfg: ReturnType<typeof resolveConfig>;
  private maxConcurrent: number;
  private syncIntervalMs: number;
  private reconnectBaseMs: number;
  private reconnectMaxMs: number;
  private query: QueryFn;
  private fetchImpl: typeof fetch;
  private log: (level: 'info' | 'warn' | 'error', msg: string) => void;

  private channels = new Map<string, ChannelState>(); // keyed by account.id
  private accountSyncTimer: ReturnType<typeof setInterval> | null = null;
  private running = 0;
  private waiters: Array<() => void> = [];
  private stopped = false;

  constructor(opts: DispatcherOptions = {}) {
    this.cfg = resolveConfig(opts);
    this.maxConcurrent = opts.maxConcurrentWorkers ?? DEFAULT_MAX_CONCURRENT;
    this.syncIntervalMs = opts.accountSyncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.reconnectBaseMs = opts.sseReconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = opts.sseReconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.query = opts.querySdk ?? defaultQuery();
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.log = opts.log ?? defaultLog;

    if (!this.cfg.masterKey) {
      throw new Error('Dispatcher requires AgenticMail master key. Run `agenticmail setup` first.');
    }
  }

  async start(): Promise<void> {
    this.log('info', `[dispatcher] starting (maxConcurrent=${this.maxConcurrent}, syncEvery=${this.syncIntervalMs}ms)`);
    await this.syncAccounts();
    this.accountSyncTimer = setInterval(() => {
      this.syncAccounts().catch(err => this.log('warn', `[dispatcher] account sync failed: ${err}`));
    }, this.syncIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.accountSyncTimer) clearInterval(this.accountSyncTimer);
    this.accountSyncTimer = null;
    for (const ch of this.channels.values()) {
      ch.stopping = true;
      ch.controller?.abort();
    }
    this.channels.clear();
    this.log('info', '[dispatcher] stopped');
  }

  /** Public for tests — directly hand an event to the routing path. */
  async handleEvent(account: AgenticMailAccount, event: SSEEvent): Promise<void> {
    if (this.stopped) return;
    if (event.type === 'new' && typeof event.uid === 'number') {
      const ch = this.channels.get(account.id);
      if (ch?.seenUids.has(event.uid)) return;
      const subject = extractSubject(event);
      // Cross-type dedup: if the master API just pushed a task event for
      // us (within the suppression window) AND this incoming mail looks
      // like the matching `[RPC] / [Task]` notification, drop it. Without
      // this, every call_agent wakes the recipient TWICE — once for the
      // task event, once for the notification email — and runs the agent
      // through Claude twice per logical RPC.
      if (ch
          && Date.now() < ch.suppressTaskMailUntilMs
          && isTaskNotificationSubject(subject)) {
        this.log('info', `[dispatcher] suppressed task-notification mail wake for "${account.name}" (uid=${event.uid}, subject="${subject}") — task event already dispatched`);
        rememberBounded(ch.seenUids, event.uid);
        return;
      }
      if (ch) rememberBounded(ch.seenUids, event.uid);
      await this.spawnWorker(account, newMailPrompt(account, event), { kind: 'new-mail', uid: event.uid });
      return;
    }
    if (event.type === 'task' && typeof event.taskId === 'string') {
      // Task events broadcast to all watchers — only act if WE are the assignee.
      if (typeof event.assignee === 'string'
          && event.assignee.toLowerCase() !== account.name.toLowerCase()) return;
      const ch = this.channels.get(account.id);
      if (ch?.seenTaskIds.has(event.taskId)) return;
      if (ch) {
        rememberBounded(ch.seenTaskIds, event.taskId);
        // Open the suppression window for the matching notification mail.
        ch.suppressTaskMailUntilMs = Date.now() + TASK_MAIL_SUPPRESS_WINDOW_MS;
      }
      await this.spawnWorker(account, taskPrompt(account, event), { kind: 'task', taskId: event.taskId });
      return;
    }
    // Other event types (expunge, flags, connected, error, reconnecting,
    // reconnect_failed, etc.) — ignore.
  }

  /**
   * Should the dispatcher own a wake-channel for this account?
   *
   * We skip the bridge agent (default name "claudecode"). The bridge is
   * the host session's own inbox proxy — when mail lands there, the
   * HOST Claude Code session reads it via MCP (`list_inbox` /
   * `wait_for_email` / `read_email`), NOT via a separately-spawned
   * dispatcher worker. Spawning a worker for the bridge would:
   *   1. Compete with the host (two Claude instances trying to "be"
   *      Claude Code, both potentially replying autonomously).
   *   2. Waste tokens — the host is already aware via its MCP polling.
   *   3. Send the bridge into an autonomous loop if it ever replies-all
   *      (because that mail would wake it again, ad infinitum).
   *
   * Role="bridge" is also skipped for symmetry with selectExposableAgents
   * in install.ts — anything tagged as a bridge is host-managed.
   */
  private shouldWatch(account: AgenticMailAccount): boolean {
    const bridgeName = this.cfg.bridgeAgentName.toLowerCase();
    if (account.name.toLowerCase() === bridgeName) return false;
    if (account.role === 'bridge') return false;
    return true;
  }

  /** Re-fetch /accounts; open SSE for new ones, close for vanished ones. */
  private async syncAccounts(): Promise<void> {
    let accounts: AgenticMailAccount[];
    try {
      accounts = await listAccounts(this.cfg.apiUrl, this.cfg.masterKey);
    } catch (err) {
      this.log('warn', `[dispatcher] could not list accounts: ${(err as Error).message}`);
      return;
    }
    // Filter out the bridge — it's host-owned, not dispatcher-owned.
    accounts = accounts.filter(a => this.shouldWatch(a));
    const liveIds = new Set(accounts.map(a => a.id));
    // Close channels for accounts that disappeared.
    for (const [id, ch] of this.channels) {
      if (!liveIds.has(id)) {
        ch.stopping = true;
        ch.controller?.abort();
        this.channels.delete(id);
        this.log('info', `[dispatcher] account "${ch.account.name}" removed — closed SSE channel`);
      }
    }
    // Open channels for new accounts.
    for (const account of accounts) {
      if (this.channels.has(account.id)) {
        // Refresh stored account metadata in case name/role changed.
        this.channels.get(account.id)!.account = account;
        continue;
      }
      const ch: ChannelState = {
        account,
        controller: null,
        stopping: false,
        backoffMs: this.reconnectBaseMs,
        seenUids: new Set(),
        seenTaskIds: new Set(),
        suppressTaskMailUntilMs: 0,
      };
      this.channels.set(account.id, ch);
      this.log('info', `[dispatcher] opening SSE for "${account.name}" (${account.email})`);
      void this.runChannel(ch);
    }
  }

  /** Watch one account's SSE stream forever; reconnect with backoff on drop. */
  private async runChannel(ch: ChannelState): Promise<void> {
    while (!ch.stopping && !this.stopped) {
      try {
        ch.controller = new AbortController();
        await this.streamOne(ch);
        if (!ch.stopping) {
          this.log('warn', `[dispatcher] SSE for "${ch.account.name}" ended unexpectedly; reconnecting in ${ch.backoffMs}ms`);
        }
      } catch (err) {
        if (ch.stopping) break;
        this.log('warn', `[dispatcher] SSE error for "${ch.account.name}": ${(err as Error).message}; reconnecting in ${ch.backoffMs}ms`);
      }
      if (ch.stopping) break;
      await sleep(ch.backoffMs);
      ch.backoffMs = Math.min(ch.backoffMs * 2, this.reconnectMaxMs);
    }
  }

  /** Single SSE attach. Returns when the stream closes for any reason. */
  private async streamOne(ch: ChannelState): Promise<void> {
    const url = `${this.cfg.apiUrl.replace(/\/$/, '')}/api/agenticmail/events`;
    const res = await this.fetchImpl(url, {
      headers: {
        'Authorization': `Bearer ${ch.account.apiKey}`,
        'Accept': 'text/event-stream',
      },
      signal: ch.controller!.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE handshake HTTP ${res.status}`);
    }
    // Reset backoff once we have a healthy stream.
    ch.backoffMs = this.reconnectBaseMs;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!ch.stopping) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // SSE framing: events separated by \n\n; each event is one-or-more
      // lines, of which the "data: …" lines hold our payload.
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let event: SSEEvent;
          try { event = JSON.parse(line.slice(6)) as SSEEvent; } catch { continue; }
          // Route in the background — don't block the SSE reader.
          this.handleEvent(ch.account, event).catch(err =>
            this.log('error', `[dispatcher] handleEvent threw for "${ch.account.name}": ${err}`)
          );
        }
      }
    }
  }

  /** Acquire a concurrency slot, run a worker, release the slot. */
  private async spawnWorker(account: AgenticMailAccount, prompt: string, ctx: { kind: string; uid?: number; taskId?: string }): Promise<void> {
    await this.acquireSlot();
    try {
      const { body } = loadPersonaForAgent({
        agent: account,
        agentsDir: this.cfg.agentsDir,
        subagentPrefix: this.cfg.subagentPrefix,
        mcpServerName: this.cfg.mcpServerName,
      });
      this.log('info', `[dispatcher] waking "${account.name}" — ${ctx.kind}${ctx.taskId ? ' ' + ctx.taskId : ctx.uid ? ' uid=' + ctx.uid : ''}`);
      const mcpEnv = await this.buildMcpEnv();
      await runWorker(
        this.query,
        body,
        prompt,
        account,
        this.cfg.mcpServerName,
        this.cfg.mcpCommand,
        this.cfg.mcpArgs,
        mcpEnv,
        this.log,
      );
    } finally {
      this.releaseSlot();
    }
  }

  /** Build the env block we pass to the worker's MCP server child process. */
  private async buildMcpEnv(): Promise<Record<string, string>> {
    // Master key gives the MCP server everything it needs — including
    // on-demand `_account` resolution via the lazy-cache path. We do NOT
    // pin AGENTICMAIL_ACCOUNT_KEYS_JSON here; letting the MCP server's
    // cache fill itself keeps workers from going stale when accounts
    // change underneath us.
    return {
      AGENTICMAIL_API_URL: this.cfg.apiUrl,
      AGENTICMAIL_MASTER_KEY: this.cfg.masterKey,
      // No AGENTICMAIL_API_KEY: workers should ALWAYS pass `_account`
      // explicitly. Omitting the default key forces that discipline at
      // the MCP-server level (any forgotten `_account` becomes a clear
      // error rather than a silent identity drift).
    };
  }

  private acquireSlot(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.waiters.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.running--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultLog(level: 'info' | 'warn' | 'error', msg: string): void {
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
}

/**
 * Lazy load the Claude Agent SDK's query() so the module imports cleanly
 * in test environments that mock it. Throws a clear error if the SDK
 * isn't installed (rather than the cryptic `MODULE_NOT_FOUND`).
 */
function defaultQuery(): QueryFn {
  return (params) => {
    let inner: AsyncIterable<unknown> | null = null;
    const init = async (): Promise<AsyncIterable<unknown>> => {
      try {
        const mod = await import('@anthropic-ai/claude-agent-sdk');
        return (mod.query as unknown as QueryFn)(params);
      } catch (err) {
        throw new Error(
          `Dispatcher needs @anthropic-ai/claude-agent-sdk installed in the package, but: ${(err as Error).message}`,
        );
      }
    };
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (!inner) inner = await init();
            const it = (inner as AsyncIterable<unknown>)[Symbol.asyncIterator]();
            // Replace the next() of THIS iterator after first init so we
            // don't keep re-asking inner for a new iterator. Simpler: just
            // call next on the cached iterator each time.
            // (The cached `it` is recreated only on the very first call.)
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const self = this;
            self.next = it.next.bind(it);
            return it.next();
          },
        };
      },
    };
  };
}
