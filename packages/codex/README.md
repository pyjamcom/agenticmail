# @agenticmail/codex

> OpenAI Codex CLI integration for AgenticMail — surfaces every AgenticMail agent as a native Codex subagent and wires the dispatcher daemon to the Codex SDK so agents wake on their own mail and tasks.

This is the Codex CLI sibling of [`@agenticmail/claudecode`](../claudecode). It uses the same dispatcher core (per-agent serialization, wake-coalesce, wake-budget, restart recovery, capabilities preamble) — only the host bindings differ.

## What it does

Five things, one binary each:

1. **MCP server registration.** Writes `[mcp_servers.agenticmail]` into `~/.codex/config.toml` so the AgenticMail toolbelt (~60 tools under `mcp__agenticmail__*`) is available inside every Codex session.
2. **Multi-agent feature flag.** Sets `features.multi_agent_v2.enabled = true` so Codex exposes the `spawn_agent` tool to the model.
3. **Subagent registration.** Writes one TOML file per AgenticMail account into `~/.codex/agents/` so each agent is callable as `spawn_agent({ agent_type: "agenticmail-<name>", message: "..." })`.
4. **Lifecycle hooks.** Registers the mail-hook on `SessionStart` / `UserPromptSubmit` / `Stop` in `~/.codex/hooks.json` — injects the capabilities preamble on session start (including after auto-compact, where `session_id` survives but model context is wiped), surfaces fresh inbox mail before user prompts, and forces continuation on stop when there's bridge mail to act on.
5. **Dispatcher daemon.** Long-running PM2-managed process that watches every AgenticMail account's IMAP IDLE stream and spawns a one-shot Codex turn (via [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk)) for each new mail or task event.

## Install

```
npm install -g @agenticmail/codex
agenticmail-codex install
```

The install command writes config + agent files + hooks idempotently. Re-runs are no-ops when nothing has changed.

```
agenticmail-codex status         # is everything wired up?
agenticmail-codex uninstall      # remove everything we wrote
agenticmail-codex --help
```

You can also drive it programmatically:

```ts
import { install, uninstall, status } from '@agenticmail/codex';
const result = await install();
```

## Architecture

Same shape as the Claude Code integration — only the host bindings differ:

| | Claude Code | Codex |
|---|---|---|
| Global config | `~/.claude.json` (JSON) | `~/.codex/config.toml` (TOML) |
| Hooks file | nested in `~/.claude/settings.json` | separate `~/.codex/hooks.json` |
| Agent file format | markdown + YAML frontmatter | TOML with `developer_instructions` heredoc |
| Spawn tool | `Agent({ subagent_type, prompt })` | `spawn_agent({ agent_type, message })` |
| Feature gate | none | `features.multi_agent_v2.enabled = true` |
| SDK | `@anthropic-ai/claude-agent-sdk` | `@openai/codex-sdk` |

The dispatcher's event loop reads Claude-shaped frames (assistant text, tool_use, tool_result, result). For Codex, a small adapter in `dispatcher.ts:defaultQuery` translates Codex's `ThreadEvent` stream into Claude-shaped frames so the rest of the dispatcher (channels, wakes, coalesce, budget, catch-up scan, dispatcher-state persistence) stays unchanged.

Codex's `ThreadEvent` → Claude frame mapping:

| Codex event | Claude frame |
|---|---|
| `item.completed(agent_message)` | `{ type: 'assistant', message: { content: [{ type: 'text', text }] } }` |
| `item.completed(mcp_tool_call)` | `{ type: 'assistant', ..., tool_use: mcp__<server>__<tool> }` + `{ type: 'user', ..., tool_result }` |
| `item.completed(command_execution)` | tool_use `Bash` + tool_result with `aggregated_output` |
| `item.completed(file_change)` | tool_use `Edit` with `changes` |
| `item.completed(web_search)` | tool_use `WebSearch` with `query` |
| `turn.completed` | `{ type: 'result', result: <final_text>, usage }` |
| `turn.failed` / `error` | `{ type: 'result', result: '[error] ...', usage: {} }` |
| `reasoning` / `todo_list` | dropped (no Claude equivalent surfaced today) |

This keeps the `read_email(uid)` end-of-turn dedup logic (added in 0.9.5) working without modification — the tool_use breadcrumb format matches what the existing regex expects.

## Environment overrides

| Env var | What it overrides |
|---|---|
| `AGENTICMAIL_API_URL` | AgenticMail master API URL (default `http://127.0.0.1:3829`) |
| `AGENTICMAIL_MASTER_KEY` | Master key (otherwise read from `~/.agenticmail/config.json`) |
| `CODEX_HOME` | Codex's home dir (default `~/.codex`) |
| `CODEX_AGENTS_DIR` | Codex agents dir (default `<CODEX_HOME>/agents`) |
| `AGENTICMAIL_DISPATCHER_MAX` | Worker concurrency cap (default 50) |
| `AGENTICMAIL_DISPATCHER_SYNC` | Account sync interval ms (default 30000) |

## Status reporting

```
agenticmail-codex status
```

Prints a one-line state plus details:

- **MCP server registered:** is `[mcp_servers.agenticmail]` in `~/.codex/config.toml`?
- **multi_agent_v2 enabled:** is `spawn_agent` exposed to the model?
- **Bridge agent in AgenticMail:** does the `codex` account exist on the master API?
- **Subagent files:** how many `agenticmail-*.toml` files are in `~/.codex/agents/`?
- **Dispatcher daemon:** running? restart count? uptime?

`status --json` emits the same data as machine-readable JSON for CI / scripting.

## Idempotency + ownership

Every file we write carries a `# managed-by: @agenticmail/codex` marker. The installer:

- never overwrites a user-authored agent file with the same name
- never touches keys in `config.toml` other than `[mcp_servers.<our-name>]` and `features.multi_agent_v2.enabled`
- preserves other users' hook entries on the same events
- prunes our agent files when their target AgenticMail account no longer exists

Uninstall reverses everything we wrote, leaving user state untouched. By default it keeps the bridge agent in AgenticMail (an account with an inbox, contacts, etc. shouldn't disappear silently); pass `--purge-bridge` to delete it.

## External inbox exposure — what `setup-email` actually does to your dispatcher

> **Once the operator runs `agenticmail setup-email`, every Codex subagent on this machine becomes reachable from the public internet via Gmail / Outlook plus-addressing.** Worth surfacing before the operator connects a relay:

- **Plus-addresses are publicly guessable.** Anyone can hit `your-relay+secretary@gmail.com`, `your-relay+kepler@gmail.com`, … and the matching subagent's inbox receives the mail. The `+sub` part is not a secret.
- **External mail goes through the same `handleEvent` path as internal `@localhost` mail.** Dedup, thread-cache, and wake-budget checks all run; if they pass, the Codex dispatcher spawns a fresh worker turn via `@openai/codex-sdk` to process the message. Source doesn't matter to the wake path.
- **The bridge takes a different path on purpose.** Mail to `your-relay+codex@gmail.com` routes to `handleBridgeMail`, which uses `codex.resumeThread(id).runStreamed(prompt)` to wake the operator's last thread headlessly rather than spawning a new worker — so external mail to the bridge can wake your interactive CLI, not just background turns. If resume fails (thread expired, no host CLI running), it falls through to the bridge-escalation email at `setup_operator_email`.
- **Spam wakes Codex turns.** A scraper that finds a plus-address can drive billable Codex invocations. Throttles available, ordered from least invasive:
  1. The `wake-budget` guard in `dispatcher.handleEvent` (default cap per minute per agent — automatic).
  2. Relay-level spam filtering before the SSE event publishes.
  3. For subagents that should stay internal-only, set `metadata.host` to a value no dispatcher matches so external mail still lands in the inbox but no worker spawns.

## See also

- [`@agenticmail/claudecode`](../claudecode) — same pattern for Anthropic's Claude Code
- [AgenticMail wiki](https://github.com/agenticmail/agenticmail/wiki) — architecture, roadmap, operator guide
- [Codex CLI](https://github.com/openai/codex) — the host
- [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) — the SDK we drive workers through
