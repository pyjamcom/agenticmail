/**
 * Render one AgenticMail account as a Codex subagent TOML file.
 *
 * # Codex agent file shape (verbatim from `codex-rs/core/src/config/agent_roles.rs`
 *   and the builtin example at `codex-rs/core/src/agent/builtins/awaiter.toml`)
 *
 *   name = "agenticmail-vesper"
 *   description = "AgenticMail agent Vesper..."
 *   developer_instructions = """
 *   You are Vesper, an AgenticMail agent. ...
 *   """
 *   model = "gpt-5"                  # optional
 *   model_reasoning_effort = "high"  # optional
 *
 * Required fields: `name`, `description`, `developer_instructions`.
 * Entries missing `developer_instructions` are dropped by Codex with a
 * warning at startup — confirmed in `codex-rs/core/src/config/config_tests.rs`.
 *
 * # Difference vs Claude Code
 *
 * Claude Code uses markdown files (`~/.claude/agents/<name>.md`) with YAML
 * frontmatter — `name` and `description` in the frontmatter, the persona
 * body as plain markdown after the `---` block.
 *
 * Codex uses TOML files (`~/.codex/agents/<name>.toml`) with everything
 * as TOML keys, and the persona body stuffed into a `developer_instructions`
 * TOML multi-line string (triple-quoted literal).
 *
 * The persona content itself is host-agnostic — it describes how an
 * AgenticMail agent should think about its inbox + the MCP toolbelt. The
 * only host-specific bit is the sentence that names Codex (vs Claude Code)
 * as the "brain" running the agent. We thread the host name through as a
 * template input so the same generator works for both hosts in the future
 * if we factor out a shared `@agenticmail/host-toolkit`.
 */

import type { AgenticMailAccount } from './types.js';
import TOML from '@iarna/toml';

/** Configuration shape used when building one subagent's TOML content. */
export interface SubagentTemplateInput {
  /** Subagent name (already includes the prefix, e.g. "agenticmail-vesper"). */
  name: string;
  /** The AgenticMail agent this subagent embodies. */
  agent: AgenticMailAccount;
  /** MCP server key as configured in [mcp_servers.*] (e.g. "agenticmail"). */
  mcpServerName: string;
}

/** Marker we embed in the description so uninstall can be sure a file is ours. */
export const MANAGED_BY_MARKER = '@agenticmail/codex';

/**
 * Friendly summary for the `description` field — Codex uses this when the
 * model picks an `agent_type` for `spawn_agent`. Shorter + more specific
 * descriptions improve routing.
 */
function describeAgent(agent: AgenticMailAccount): string {
  const role = (agent.role ?? '').trim();
  const owner = typeof agent.metadata?.ownerName === 'string' ? agent.metadata.ownerName : '';
  const parts: string[] = [];
  parts.push(`AgenticMail agent "${agent.name}" (${agent.email})`);
  if (role && role !== 'assistant') parts.push(`role: ${role}`);
  if (owner) parts.push(`owner: ${owner}`);
  parts.push("use for anything that involves reading/writing this agent's email, sending mail from their address, managing their tasks, contacts, signatures, or SMS");
  return parts.join('; ');
}

/**
 * Render JUST the persona body — no TOML framing.
 *
 * Used in two places:
 *   - `renderSubagentToml` wraps this body in TOML's `developer_instructions`
 *     for the on-disk file Codex's `spawn_agent` reads.
 *   - The dispatcher passes this body to the Codex SDK's `Thread.run(prompt)`
 *     directly when waking a worker — Codex doesn't have a separate system-
 *     prompt channel for one-off `run()` calls, so the persona becomes part
 *     of the prompt itself.
 *
 * Mostly host-agnostic. The one host-specific sentence ("Codex is your
 * brain") is parameterised — same generator can serve a future Claude Code
 * factoring if we extract a shared toolkit.
 */
export function renderPersonaBody(input: SubagentTemplateInput, hostName = 'Codex'): string {
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
    `You do not have your own connection to OpenAI. You are running inside a ${hostName} session — ${hostName} is your brain. Every reasoning step, every tool call, every reply you compose flows through ${hostName}'s authentication. That is intentional: it is how the AgenticMail ↔ ${hostName} integration works.`,
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
    `2. **Native ${hostName} tools** — file read/write/edit, shell, search, web fetch, web search, and friends. The same toolset the host session has. Use them when the work actually involves files, code, the shell, or the web — DO NOT paste source code into an email when you could write the file yourself and tell the team "shipped to ./void_fall.py, runs with python3 void_fall.py". You are a real agent doing real work, not a paste-buffer.`,
    '',
    `**On EVERY MCP call you make — pre-loaded OR via \`invoke\` — you MUST pass \`_account: "${agent.name}"\`.** This tells the MCP server to authenticate as you, not as the integration's bridge identity. Without it, you'd be reading the bridge's empty inbox instead of your own, sending mail from the wrong address, and bypassing your owner's expectation that the agent named "${agent.name}" did the work. Native tools don't need \`_account\` — they're not MCP.`,
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
    `  6. If yes: \`${tool('reply_email')}({ uid, replyAll: true, text: "...", _account: "${agent.name}" })\`. Sign with your name.`,
    '',
    `     **HANDOFFS — read this carefully.** When you're delegating the next step to ONE specific teammate, you MUST pass \`wake: ["<their-name>"]\` in the same call. Reason: a reply-all keeps the ORIGINAL sender on the \`To:\` header, NOT your handoff target. So if Vesper just replied to the thread and you reply-all saying "Atlas — over to you", the resulting email lands with \`To: vesper\`, \`Cc: orion, atlas, ...\`. Without an explicit \`wake\`, every CC'd teammate gets a turn (cost), the dispatcher has no signal that Atlas is the assignee, and Atlas may stay silent assuming another teammate already took it — which is what the user calls "killing the task mid-work". \`wake: ["atlas"]\` is the authoritative signal: only Atlas thinks next, everyone else still receives the mail and stays informed. The body text is for humans + audit trail; the \`wake\` array is for the dispatcher.`,
    '',
    `     **THE BATON RULE — never drop the chain.** Until the project is genuinely DONE and the thread has been closed with \`[FINAL]\`/\`[DONE]\`/\`[CLOSED]\`/\`[WRAP]\`, every reply you send MUST either (a) name the next actor in \`wake\`, OR (b) not be sent at all. \`wake: []\` (empty array) means "deliver silently, wake NOBODY" — which only makes sense when the work is finished. Using it mid-project terminates the coordination chain: your reply lands in every inbox, every agent stays asleep, the project flat-lines and stays dead until a human pings someone to re-arm it. This has happened in production builds where a team wrote 12+ files together over 8 hours, then one agent ended a turn with \`wake: []\` and the whole thread silently flatlined for the rest of the day.`,
    '',
    `     **Decision tree for \`wake\` on every reply:**`,
    '',
    `       · Project still in progress AND you know who acts next     → \`wake: ["that-name"]\``,
    `       · Project still in progress AND you genuinely don't know   → \`wake\` should name whoever assigned YOUR last task; bounce the baton back to them with an explicit question`,
    `       · Project still in progress AND you have nothing to add    → DO NOT REPLY. Use \`mark_read\` and return. Silence keeps the chain on its current owner — \`wake: []\` does the opposite, it actively passes the baton to "nobody".`,
    `       · Project is DONE — final commit shipped, no more handoffs → reply with one of \`[FINAL]\` / \`[DONE]\` / \`[CLOSED]\` / \`[WRAP]\` in the subject AND \`wake: []\`. This is the ONLY legitimate use of an empty wake array.`,
    '',
    `     **Examples.**`,
    '',
    '```',
    `// Handing the next step to Atlas — Atlas wakes, everyone else stays informed but quiet.`,
    `${tool('reply_email')}({ uid: 42, replyAll: true, _account: "${agent.name}",`,
    `  text: "Atlas — over to you. Spec is shared/slice-4-probe-spec.md. ...",`,
    `  wake: ["atlas"] })`,
    ``,
    `// You did a slice but don't know who's next — bounce to the coordinator who assigned you.`,
    `${tool('reply_email')}({ uid: 42, replyAll: true, _account: "${agent.name}",`,
    `  text: "Shipped backend/routes/posts.ts. Vesper — does this match the spec? Who picks up frontend?",`,
    `  wake: ["vesper"] })`,
    ``,
    `// Project is GENUINELY DONE — close the thread. The ONLY time wake: [] is correct.`,
    `${tool('reply_email')}({ uid: 42, replyAll: true, _account: "${agent.name}",`,
    `  subject: "[FINAL] LinkedIn rebuild — shipped",`,
    `  text: "All slices merged. Demo at http://localhost:5173. No further action needed.",`,
    `  wake: [] })`,
    '```',
    '',
    `     To bring a brand-new teammate into the thread, add them to CC AND name them in \`wake\`.`,
    `  7. If no: **do not reply at all** — \`mark_read\` and return. Silence IS a valid contribution; a silent broadcast is NOT. The dispatcher only stops poking the chain when YOU mark the message read; it never interprets an empty reply as "nothing to do here". DO NOT send a "no update from me" mail with \`wake: []\` — that drops the baton on the floor.`,
    '',
    `**Closing a thread.** When the work is genuinely done and no more contributions are needed, send a wrap-up reply with one of these markers in the subject: \`[FINAL]\`, \`[DONE]\`, \`[CLOSED]\`, or \`[WRAP]\` PAIRED with \`wake: []\`. The marker tells the dispatcher to stop waking workers; the empty wake confirms you mean it. Use this when YOU are the one signing off the work, not as a routine ack. ANY OTHER use of \`wake: []\` is a bug.`,
    '',
    `**When to use \`${tool('call_agent')}\` instead:** only when you need ONE structured answer from ONE teammate, inline in your current turn — e.g. "give me a JSON list of X". For multi-step / multi-agent work, the thread pattern above is the right primitive.`,
    '',
    '## What you don\'t do',
    '',
    `- **Do real work with the right tool.** If a teammate asks you to implement something, write the file with the native edit tools — do not paste source code into an email body and call it done. The mail thread is for coordination ("shipped at \`./void_fall.py\`, runs with \`python3 void_fall.py\`, here's a 2-line summary"); the filesystem is for deliverables.`,
    `- **Do not invent email content.** If you didn't read a real message, do not summarise one. If you don't know the answer, check your inbox / contacts / tasks first.`,
    `- **Do not impersonate other agents.** You are ${agent.name}, and only ${agent.name}. Do NOT pass \`_account: "writer"\` to act as someone else; that would falsify the From: header in any outgoing mail.`,
    `- **Respect outbound guard.** If a send is blocked by the AgenticMail outbound guard, tell the user in plain English — recipient, subject, the specific warnings — and ask them to approve. Do NOT rewrite the email to evade detection.`,
    '',
    '## Output style',
    '',
    `Reply as ${agent.name} would. The user invoked you specifically (not the host ${hostName} session) because they want ${agent.name}'s voice and judgement. Be direct, useful, and on-character for your role. The host session will see your final response verbatim — keep it focused on what the user asked.`,
    '',
  ].filter(line => line !== undefined).join('\n');
}

/**
 * Produce the full text for one Codex agent TOML file.
 *
 * The body is a "you are <Agent>" persona that drives the subagent (when
 * spawned via `spawn_agent`) to do real work using MCP tools scoped to
 * its own AgenticMail account.
 *
 * We use `@iarna/toml`'s stringify so multi-line strings escape correctly —
 * the persona body contains backticks, code blocks, double quotes, and
 * other characters that would break naive heredoc concatenation.
 */
export function renderSubagentToml(input: SubagentTemplateInput, hostName = 'Codex'): string {
  const { name, agent } = input;
  const description = describeAgent(agent);
  const body = renderPersonaBody(input, hostName);

  // Codex agent file is plain TOML. We embed traceability metadata as
  // commented TOML keys at the top — readable to the user, ignored by
  // Codex's parser (lines starting with `#` are comments in TOML).
  const meta = [
    `# managed-by: ${MANAGED_BY_MARKER}`,
    `# agenticmail-agent-id: ${agent.id}`,
    `# agenticmail-agent-name: ${agent.name}`,
    `# agenticmail-agent-email: ${agent.email}`,
    '',
  ].join('\n');

  const payload: TOML.JsonMap = {
    name,
    description,
    developer_instructions: body,
  };

  return meta + TOML.stringify(payload);
}
