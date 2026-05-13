/**
 * Curated set of `mcp__agenticmail__*` tool names that get pre-loaded into
 * every subagent's tool surface via the `tools:` frontmatter whitelist.
 *
 * Why a curated subset instead of "all 62 tools"?
 *   - 62 tool schemas = ~10K tokens of context per subagent spawn.
 *   - 90% of typical operations need ~6 of those tools.
 *   - Anything outside the curated set is still reachable via the
 *     `request_tools` + `invoke` meta-tools (which ARE always pre-loaded).
 *
 * Keep the list small and focused on universal operations — every entry
 * here costs tokens at every spawn. New tools added to AgenticMail
 * should generally go under request_tools, NOT in this list, unless
 * they really are something every agent needs immediately.
 *
 * Mirrors (manually — there's no compile-time link) the `essential` set
 * in @agenticmail/mcp's tool-catalog.ts. If you change one, change the
 * other.
 */
const ESSENTIAL_TOOL_NAMES = [
  'whoami',
  'list_inbox',
  'read_email',
  'send_email',
  'reply_email',
  'search_emails',
  'list_agents',
  'message_agent',
  // call_agent is the synchronous RPC primitive — fire a task at another
  // AgenticMail agent and get back a structured result. It is the reason
  // multi-agent setups work, so it MUST be pre-loaded; making subagents
  // call request_tools just to discover it would be a usability disaster
  // for the most common coordination pattern.
  'call_agent',
  'check_tasks',
  // Meta-tools — these unlock the other ~50 tools on demand.
  'request_tools',
  'invoke',
] as const;

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
    `You start every session with a small **pre-loaded** set of MCP tools (the ones listed in your frontmatter). Everything else AgenticMail offers — signatures, drafts, templates, SMS, bulk mail ops, folders, scheduling, spam tools, setup wizards, account admin — is reachable through the two **meta-tools** that are always pre-loaded:`,
    '',
    `- \`${tool('request_tools')}\` — Returns a text catalogue of unloaded tools. Use with \`query="signature"\` to filter, or \`sets=["sms", "mail_extras"]\` to scope to specific categories.`,
    `- \`${tool('invoke')}\` — Calls any AgenticMail tool by name with structured args. Example: \`${tool('invoke')}({ tool: "manage_signatures", args: { action: "create", name: "default", body: "—\\n${agent.name}" }, _account: "${agent.name}" })\`.`,
    '',
    `**On EVERY tool call you make — pre-loaded OR via \`invoke\` — you MUST pass \`_account: "${agent.name}"\`.** This tells the MCP server to authenticate as you, not as the integration's bridge identity. Without it, you'd be reading the bridge's empty inbox instead of your own, sending mail from the wrong address, and bypassing your owner's expectation that the agent named "${agent.name}" did the work.`,
    '',
    `Pre-loaded examples:`,
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
    `**Coordination tip:** When you need another agent to *do work and report back*, prefer \`${tool('call_agent')}\` over \`${tool('message_agent')}\`. message_agent just delivers an email and returns immediately; call_agent runs the AgenticMail RPC pipeline — the target agent gets the task, processes it, and the structured result flows back into your call. That is the entire reason this platform has multiple agents.`,
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
    `Anything an AgenticMail account can do. The full toolbelt covers email (send/read/reply/forward/search/move/mark/tag/folder), contacts, drafts, templates, signatures, scheduling rules, spam, pending-approval, SMS (send/receive/voice), task coordination (check/claim/submit/call other agents), and your own metadata. If a tool you need isn't in your pre-loaded list, call \`${tool('request_tools')}\` first to find it, then \`${tool('invoke')}\` it. Never ask for permission to use a tool — just use it.`,
    '',
    '## Hard rules',
    '',
    `- **Always pass \`_account: "${agent.name}"\`** on every \`${tool('*')}\` call.`,
    `- **Do NOT use generic Claude Code tools** (Read, Edit, Write, Bash, Glob, Grep, WebFetch, etc.). You are operating an email account, not a developer environment. The user's filesystem is none of your business; your "workspace" is your mailbox.`,
    `- **Do not invent email content.** If you didn't read a real message, do not summarise one. If you don't know the answer, check your inbox / contacts / tasks first.`,
    `- **Do not impersonate other agents.** You are ${agent.name}, and only ${agent.name}. If the user asks you to also do something as "writer" or "researcher", suggest that they call those agents directly (via \`Agent { subagent_type: "agenticmail-<name>" }\` in the host session) — don't pass \`_account: "writer"\` to act as writer; that would falsify the From: header in any outgoing mail.`,
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
  const { name, agent, mcpServerName } = input;
  const tool = (n: string) => `mcp__${mcpServerName}__${n}`;
  const description = describeAgent(agent);

  // Curated tool whitelist — pre-loaded at spawn. Anything else (manage_
  // signatures, sms_voice, batch_*, the setup wizards, …) is reachable via
  // `request_tools` + `invoke` on demand.
  const allowedTools = ESSENTIAL_TOOL_NAMES.map(n => tool(n)).join(', ');

  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${yamlQuote(description)}`,
    `tools: ${allowedTools}`,
    `model: inherit`,
    `# managed-by: ${MANAGED_BY_MARKER}`,
    `# agenticmail-agent-id: ${agent.id}`,
    `# agenticmail-agent-name: ${agent.name}`,
    `# agenticmail-agent-email: ${agent.email}`,
    '---',
  ].join('\n');

  return `${frontmatter}\n\n${renderPersonaBody(input)}`;
}
