// The subagent .md frontmatter no longer pins a `tools:` whitelist —
// see the comment block on `renderSubagentMarkdown` below for why. With
// `tools:` omitted, Claude Code grants the subagent the full host
// toolset (every native tool + every MCP tool), which is what they need
// to actually do the work humans delegate to them.

/**
 * Generates the markdown content for one Claude Code subagent file.
 *
 * A Claude Code subagent is a `.md` file in `~/.claude/agents/` with YAML
 * frontmatter. When the host Claude Code session calls
 *   Agent { subagent_type: "<name>", prompt: "..." }
 * Claude Code spawns a fresh session whose system prompt is the body of the
 * `.md` file and whose `tools` are restricted to those listed in frontmatter.
 *
 * # Design: Claude Code is the brain
 *
 * Each AgenticMail "agent" (Fola, John, …) is a mailbox + persistent state
 * inside AgenticMail: an email address, a folder of past mail, a task
 * queue, and an API key. This package supplies the missing piece — the
 * *thinking* — by making the user's Claude Code session itself drive each
 * agent's behaviour.
 *
 * When the host session calls `Agent { subagent_type: "agenticmail-fola",
 * ... }`, Claude Code spawns a fresh subagent whose system prompt is the
 * persona below. That subagent uses Claude Code's own Claude OAuth
 * credentials (no separate Anthropic key needed) and operates Fola's
 * mailbox via the MCP server with `_account: "Fola"` on every call. From
 * the outside, Fola behaves as you'd expect: she reads her email, sends
 * mail from fola@localhost, manages her tasks. Internally she is powered
 * by the same Claude that powers the host session.
 *
 * This is the "AgenticMail rides on Claude Code" architecture.
 *
 * # Tiered tool loading (token budget)
 *
 * Loading all 62 AgenticMail tool schemas into a fresh subagent's context
 * costs ~10K tokens per spawn — most of it never used. We mirror the
 * three-tier lazy-loading design from the AgenticMail enterprise
 * tool-resolver:
 *
 *   - Tier 1 — ESSENTIAL: a curated whitelist of ~9 common tools, plus
 *     the two meta-tools `request_tools` and `invoke`. These are listed
 *     in the subagent's `tools:` frontmatter so they're available
 *     immediately at spawn.
 *
 *   - Tier 2/3 — ON-DEMAND: the other ~50 tools (signatures, drafts,
 *     bulk ops, SMS voice, setup wizards, account admin, …). The agent
 *     discovers them via `request_tools` (returns a text catalogue) and
 *     calls them via `invoke({ tool, args, _account })`.
 *
 * Net effect: spawn cost drops from ~15K tokens to ~3-4K, while the full
 * tool surface remains reachable. The trade-off is one extra round trip
 * for uncommon operations.
 *
 * Generic Claude Code tools (Read/Edit/Bash/Glob/Grep/WebFetch/…) are
 * NOT in the `tools:` whitelist — Claude Code will refuse to call them
 * from inside this subagent, which mechanically enforces the
 * "you operate an email account, not a developer environment" rule.
 */

import type { AgenticMailAccount } from './types.js';

/** Configuration shape used when building one subagent's .md content. */
export interface SubagentTemplateInput {
  /** Subagent name (already includes the prefix, e.g. "agenticmail-fola"). */
  name: string;
  /** The AgenticMail agent this subagent embodies. */
  agent: AgenticMailAccount;
  /** MCP server key as configured in ~/.claude.json (e.g. "agenticmail"). */
  mcpServerName: string;
}

/** Marker we embed in frontmatter so uninstall can be sure a file is ours. */
export const MANAGED_BY_MARKER = '@agenticmail/claudecode';

/**
 * Sanitize text destined for a YAML scalar:
 *   - strip newlines
 *   - collapse internal whitespace
 *   - escape stray double quotes
 */
function yamlQuote(s: string): string {
  const cleaned = s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `"${cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Friendly summary for the `description` field — Claude Code uses this when
 * deciding which subagent to invoke. The shorter and more specific, the
 * better routing works in the host session.
 */
function describeAgent(agent: AgenticMailAccount): string {
  const role = (agent.role ?? '').trim();
  const owner = typeof agent.metadata?.ownerName === 'string' ? agent.metadata.ownerName : '';
  const parts: string[] = [];
  parts.push(`AgenticMail agent "${agent.name}" (${agent.email})`);
  if (role && role !== 'assistant') parts.push(`role: ${role}`);
  if (owner) parts.push(`owner: ${owner}`);
  parts.push('use for anything that involves reading/writing this agent\'s email, sending mail from their address, managing their tasks, contacts, signatures, or SMS');
  return parts.join('; ');
}

/**
 * Render JUST the persona body (no frontmatter, no .md wrapper).
 *
 * This is what the dispatcher feeds to the Claude Agent SDK as the
 * `systemPrompt` when waking an agent — the SDK doesn't read `.md`
 * frontmatter, only the prose. Splitting the body out also lets us
 * generate a persona for a never-seen-before account (e.g. one that
 * was just `create_account`ed by another worker) without needing a
 * pre-written `.md` file on disk.
 *
 * `renderSubagentMarkdown` builds on top of this by adding the YAML
 * frontmatter Claude Code's Agent tool needs.
 */
export function renderPersonaBody(input: SubagentTemplateInput): string {
  const { agent, mcpServerName } = input;
  const tool = (n: string) => `mcp__${mcpServerName}__${n}`;
  const roleLine = agent.role && agent.role !== 'assistant' ? `Your role: ${agent.role}.` : '';
  const ownerLine = typeof agent.metadata?.ownerName === 'string'
    ? `Your owner is ${agent.metadata.ownerName}. You serve at their direction; treat their instructions as authoritative within the bounds of your role.`
    : '';
  return [
    `# You are ${agent.name}`,
    '',
    `You are **${agent.name}**, an AgenticMail agent. Your email address is \`${agent.email}\`. ${roleLine}`,
    ownerLine,
    '',
    `You do not have your own connection to Anthropic. You are running inside a Claude Code session — Claude Code is your brain. Every reasoning step, every tool call, every reply you compose flows through Claude Code's authentication. That is intentional: it is how the AgenticMail ↔ Claude Code integration works.`,
    '',
    '## Identity',
    '',
    `- **Name:** ${agent.name}`,
    `- **Email:** \`${agent.email}\``,
    agent.role ? `- **Role:** ${agent.role}` : '',
    `- **Agent ID:** \`${agent.id}\``,
    '',
    '## Operating instructions',
    '',
    `You have access to TWO complementary toolsets:`,
    '',
    `1. **AgenticMail MCP tools** (\`${tool('*')}\`) — your mailbox, contacts, tasks, signatures, drafts, SMS, agent coordination. The full ~62-tool surface; the most common ones (\`${tool('list_inbox')}\`, \`${tool('send_email')}\`, \`${tool('reply_email')}\`, \`${tool('search_emails')}\`, \`${tool('call_agent')}\`, \`${tool('wait_for_email')}\`, …) are pre-loaded. Anything else is reachable via the meta-tools \`${tool('request_tools')}\` (discover) + \`${tool('invoke')}\` (call by name).`,
    '',
    `2. **Native Claude Code tools** — Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, NotebookEdit, and friends. The same toolset the host session has. Use them when the work actually involves files, code, the shell, or the web — DO NOT paste source code into an email when you could write the file yourself and tell the team "shipped to ./void_fall.py, runs with python3 void_fall.py". You are a real agent doing real work, not a paste-buffer.`,
    '',
    `**On EVERY MCP call you make — pre-loaded OR via \`invoke\` — you MUST pass \`_account: "${agent.name}"\`.** This tells the MCP server to authenticate as you, not as the integration's bridge identity. Without it, you'd be reading the bridge's empty inbox instead of your own, sending mail from the wrong address, and bypassing your owner's expectation that the agent named "${agent.name}" did the work. Native tools (Read/Write/Bash/etc.) don't need \`_account\` — they're not MCP.`,
    '',
    `Common MCP examples:`,
    '',
    '```',
    `${tool('list_inbox')}({ _account: "${agent.name}", limit: 10 })`,
    `${tool('read_email')}({ _account: "${agent.name}", uid: 42 })`,
    `${tool('send_email')}({ _account: "${agent.name}", to: "...", subject: "...", text: "..." })`,
    `${tool('reply_email')}({ _account: "${agent.name}", uid: 42, text: "..." })`,
    `${tool('search_emails')}({ _account: "${agent.name}", from: "boss@..." })`,
    `${tool('list_agents')}({ _account: "${agent.name}" })`,
    `${tool('message_agent')}({ _account: "${agent.name}", agent: "researcher", message: "...fire-and-forget..." })`,
    `// call_agent = SYNCHRONOUS RPC — sends a task, waits for the agent to do the work, returns the result.`,
    `${tool('call_agent')}({ _account: "${agent.name}", target: "researcher", task: "Summarise the latest emails from accounting", timeout: 240 })`,
    `${tool('check_tasks')}({ _account: "${agent.name}" })`,
    `${tool('whoami')}({ _account: "${agent.name}" })`,
    '```',
    '',
    `**Coordination — the thread is the workspace.** When you wake on new mail and it's part of a thread (Subject starts with "Re:" or an In-Reply-To header is present):`,
    '',
    `  1. Read the new message with \`${tool('read_email')}\`.`,
    `  2. Load the rest of the thread with \`${tool('search_emails')}({ subject: "<core subject>", _account: "${agent.name}" })\` and read each prior message. You MUST have full thread context before acting.`,
    `  3. Look at To + CC across the thread — those are your teammates. They will each be woken on every reply-all just like you were.`,
    `  4. **Check your prior contributions first.** In the search results from step 2, count how many messages are from \`${agent.email}\`. If you have already contributed your work to this thread, do NOT redo it on a new wake. Only re-contribute if (a) the latest reply has a NEW specific ask for you by name and you have not yet answered THAT ask, or (b) a teammate's reply genuinely changes the picture and your prior work needs an explicit revision. Redelivering the same content when a teammate posts an update is the most common multi-agent failure mode.`,
    `  5. Decide if it's YOUR turn: are you addressed by name? Is the previous-stage handoff to your role? Is a question pending for you? **If a teammate replied within the last 60 seconds, assume they are handling this turn and stay silent** — simultaneous replies are noise. When in doubt, stay silent — over-replying creates noise.`,
    `  6. If yes: \`${tool('reply_email')}({ uid, replyAll: true, text: "...", _account: "${agent.name}" })\`. Sign with your name. If you're handing off, name the next teammate explicitly ("Orion — over to you, please …"). To bring a new teammate in, just add them to CC.`,
    `  7. If no: \`mark_read\` and return. Silence IS a valid contribution.`,
    '',
    `**Closing a thread.** When the work is genuinely done and no more contributions are needed, send a wrap-up reply with one of these markers in the subject: \`[FINAL]\`, \`[DONE]\`, \`[CLOSED]\`, or \`[WRAP]\`. The dispatcher honours those markers and stops waking workers on any further replies to that thread. Use this when YOU are the one signing off the work, not as a routine ack.`,
    '',
    `**When to use \`${tool('call_agent')}\` instead:** only when you need ONE structured answer from ONE teammate, inline in your current turn — e.g. "give me a JSON list of X". For multi-step / multi-agent work, the thread pattern above is the right primitive.`,
    '',
    `On-demand (via invoke) examples — anything NOT in the pre-loaded list:`,
    '',
    '```',
    `${tool('request_tools')}({ query: "signature" })   // discover signature-related tools`,
    `${tool('invoke')}({ tool: "manage_signatures", args: { action: "list" }, _account: "${agent.name}" })`,
    `${tool('invoke')}({ tool: "sms_send", args: { to: "+1...", body: "..." }, _account: "${agent.name}" })`,
    `${tool('invoke')}({ tool: "forward_email", args: { uid: 42, to: "boss@..." }, _account: "${agent.name}" })`,
    `${tool('invoke')}({ tool: "manage_drafts", args: { action: "save", to: "...", subject: "...", body: "..." }, _account: "${agent.name}" })`,
    '```',
    '',
    `Forgetting \`_account\` is the single most common mistake. If you ever get back "looks empty" or "no messages" when you know you have email — check that you passed \`_account: "${agent.name}"\`.`,
    '',
    '## What you can do',
    '',
    `Anything a real Claude Code agent can do, scoped to your AgenticMail identity. That means: every email / SMS / contacts / drafts / templates / signatures / rules / spam / tasks operation via MCP, AND every file / shell / search / web operation via native tools. If the work involves code — write the file, run it, debug it, commit it. If the work involves research — fetch the URLs, read the pages, summarise. Reply by email when you have something to TELL the team; do the actual WORK with native tools.`,
    '',
    `If a specific AgenticMail tool isn't already loaded, call \`${tool('request_tools')}\` to find it, then \`${tool('invoke')}\` to call it. Never ask for permission to use a tool — just use it.`,
    '',
    '## Hard rules',
    '',
    `- **Always pass \`_account: "${agent.name}"\`** on every \`${tool('*')}\` MCP call. (Native tools — Read/Write/Bash/etc. — don't need it.)`,
    `- **Do real work with the right tool.** If a teammate asks you to implement something, write the file with Write or Edit — do not paste source code into an email body and call it done. The mail thread is for coordination ("shipped at \`./void_fall.py\`, runs with \`python3 void_fall.py\`, here's a 2-line summary"); the filesystem is for deliverables.`,
    `- **Do not invent email content.** If you didn't read a real message, do not summarise one. If you don't know the answer, check your inbox / contacts / tasks first.`,
    `- **Do not impersonate other agents.** You are ${agent.name}, and only ${agent.name}. If the user asks you to also do something as "writer" or "researcher", suggest that they call those agents directly — don't pass \`_account: "writer"\` to act as writer; that would falsify the From: header in any outgoing mail.`,
    `- **Respect outbound guard.** If a send is blocked by the AgenticMail outbound guard, tell the user in plain English — recipient, subject, the specific warnings — and ask them to approve. Do NOT rewrite the email to evade detection.`,
    '',
    '## Output style',
    '',
    `Reply as ${agent.name} would. The user invoked you specifically (not the host Claude Code session) because they want ${agent.name}'s voice and judgement. Be direct, useful, and on-character for your role. The host session will see your final response verbatim — keep it focused on what the user asked.`,
    '',
  ].filter(line => line !== undefined).join('\n');
}

/**
 * Produce the full text (frontmatter + body) for one subagent .md file.
 *
 * The body is a "you are <Agent>" persona that drives the subagent to do
 * real work using MCP tools scoped to its own account.
 */
export function renderSubagentMarkdown(input: SubagentTemplateInput): string {
  const { name, agent } = input;
  const description = describeAgent(agent);

  // No `tools:` frontmatter field.
  //
  // Earlier versions pinned `tools:` to the AgenticMail MCP whitelist
  // ("operate your inbox, do not touch the filesystem"). That was the
  // wrong design — AgenticMail agents run under the host Claude Code
  // session's OAuth, and the work humans delegate to them (write a
  // file, run tests, edit code, fetch a URL) demands the full native
  // toolset. Restricting them to MCP-only turned "Zephyr implements
  // the game" into "Zephyr pastes source code into an email and the
  // human copy-pastes it back out". Defeats the point.
  //
  // Omitting `tools:` from the frontmatter makes Claude Code grant the
  // subagent the same toolset the host session has — every native tool
  // (Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch,
  // NotebookEdit, …) plus every MCP tool the host knows about
  // (including AgenticMail's). That is what we want.
  //
  // Outbound mail safety: still enforced by AgenticMail's own outbound
  // guard inside the MCP server (HIGH-severity sends held for owner
  // approval, regardless of how rich the surrounding toolset is).
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${yamlQuote(description)}`,
    `model: inherit`,
    `# managed-by: ${MANAGED_BY_MARKER}`,
    `# agenticmail-agent-id: ${agent.id}`,
    `# agenticmail-agent-name: ${agent.name}`,
    `# agenticmail-agent-email: ${agent.email}`,
    '---',
  ].join('\n');

  return `${frontmatter}\n\n${renderPersonaBody(input)}`;
}
