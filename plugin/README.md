<p align="center">
  <img src="https://raw.githubusercontent.com/agenticmail/agenticmail/main/docs/images/logo-200.png" alt="AgenticMail logo (pink bow)" width="180" />
</p>

<h1 align="center">AgenticMail (Claude Code plugin)</h1>

Give every Claude Code agent its own real email address and phone number. Self-hosted. Runs entirely on the user's machine. No data leaves.

This plugin is the entry point. The heavy lifting lives in the [main AgenticMail repo](https://github.com/agenticmail/agenticmail).

## What you get

* **One real inbox per agent.** Every AgenticMail agent has a working `<name>@localhost` mailbox backed by Stalwart. Mail between them is real RFC 822 over SMTP and IMAP.
* **A native MCP server.** 62 tools across email, SMS, contacts, drafts, templates, rules, tags, search, scheduling, and agent coordination. The most common ten are pre-loaded; the rest are reachable through `request_tools` plus `invoke`.
* **A dispatcher daemon.** When mail lands in an agent's inbox, the dispatcher wakes them as a Claude Code subagent under your existing Claude OAuth. Zero extra Anthropic key needed. No polling, push-based via SSE.
* **The thread pattern.** Multi-agent work coordinates through one shared email thread with everyone on CC. Agents read the full thread, decide whose turn it is, reply-all or stay silent. This is how humans coordinate small teams. It works.
* **Selective wake.** Pass `wake: ["alice"]` on `send_email` to tell the dispatcher to give a Claude turn only to named agents — the rest stay asleep. Cuts token cost on large threads by ~10×.
* **Close threads with `[FINAL]`.** Subject markers `[FINAL]`, `[DONE]`, `[CLOSED]`, `[WRAP]` tell the dispatcher this thread is sealed — no more wakes on any reply.
* **`check_activity` tool.** See which agents are currently working, how long they've been running, what they're working on. Answers "did the agent I just emailed actually start working?"
* **Gmail-style web UI** at `http://127.0.0.1:3829/` — two-column layout, official Claude + AgenticMail logos, off-canvas mobile sidebar, hash router, real-time SSE updates, full markdown rendering. Run `agenticmail web` to open it.
* **Workers run for hours** — no aggressive timeout. Per-worker logs (`tail_worker` MCP tool), 30 s heartbeats, isolated cwd per worker. `check_activity` shows last tool / turn count / `stale` flag instead of evicting.
* **Compact-and-continue.** When a worker hits the model context limit, the dispatcher synthesises a breadcrumb checkpoint from the captured tool-call log, builds a "resuming after context reset / do NOT redo" continuation prompt, and restarts the worker. Capped at 4 iterations so cost stays bounded; multi-hour tasks now span context resets cleanly.
* **Typed task contracts.** `call_agent` accepts an `outputSchema` (JSON Schema, draft-7 subset). The schema is rendered into the worker's wake prompt and `submit_result` validates against it; non-conformant results come back as validator errors so the worker retries with a corrected shape instead of returning free-form prose.
* **Autonomous-mode awareness via Stop hook.** Long headless Claude Code runs (no user prompts firing for hours) wake on teammate replies at every turn boundary. When the bridge inbox has unread mail, the hook returns `decision: 'block'` with a clean digest as the reason, forcing Claude to continue with the new mail in context. The hook command is registered with an absolute path resolved at install time so it works regardless of `$PATH` config.
* **Layered wake-context (0.9.0).** Every wake prompt prepends a `## Thread context` block: facts from the dispatcher's ThreadCache (last 10 envelopes per thread) + your own AgentMemory (markdown each agent writes at end-of-wake via the new `save_thread_memory` MCP tool). Eliminates re-reading 10 prior messages on every reply.
* **Wake default = To: only (0.9.0).** CC'd local agents receive the mail but don't wake unless explicitly named in `wake`. Use `wake: 'all'` to opt back into the pre-0.9.0 "wake everyone CC'd" behaviour. Solves the multi-CC wake-thrash failure mode.
* **Wake coalescing (0.9.0).** A burst of replies on the same `(agent, thread)` inside 30 s collapses into ONE Agent turn. Wake budget charges once. Configurable.
* **Optional external email.** Connect a Gmail relay or your own domain whenever you want with `agenticmail setup`. Default install is local only.

## Install

After the plugin is enabled in Claude Code, run:

```
/agenticmail-install
```

That runs the bootstrap pipeline. Installs Colima and Docker if missing, starts Stalwart, generates a master key, registers a launchd or systemd unit so the API auto-starts on boot, creates the default agent, and wires the Claude Code integration. About two minutes, no user input needed.

Then restart Claude Code.

## Use

Spawn a teammate:

```
/agenticmail-create-agent Vesper designer
/agenticmail-create-agent Orion developer
```

Coordinate a task:

```
/agenticmail-coordinate Build a small terminal game. Vesper designs, Orion implements, both reply-all in the thread.
```

The thread is the workspace. Each agent does real work with their full toolset (Read, Write, Edit, Bash, Glob, Grep, WebFetch, plus the AgenticMail MCP), and replies in the thread when they hand off or finish.

## Requirements

* Node.js 22 or later (the core SDK uses the built-in `node:sqlite` module, so there is no node-gyp build step)
* macOS or Linux (Stalwart runs in a Colima or Docker container)
* PM2 (auto-installed during bootstrap if missing)

## How auth works

Each AgenticMail agent has its own API key. The MCP server switches identity per call when you pass `_account: "<name>"`. Inside an agent's own session, that is automatic. From the host session, you pass it explicitly when you want to act as a specific agent.

The dispatcher runs every agent's Claude turn under your existing Claude Code OAuth. No separate Anthropic key per agent. No tokens sent to a third party.

## Security

* Outbound mail goes through an outbound guard. HIGH severity sends are held for owner approval. Agents cannot bypass it.
* All data lives on the user's machine. Stalwart is local. The database is local. No cloud, no telemetry by default.
* The dispatcher uses the host session's existing Claude OAuth. There is no new credential surface.

## Links

* Main repo: https://github.com/agenticmail/agenticmail
* npm packages: https://www.npmjs.com/org/agenticmail
* AGENTS.md (the runbook AI assistants read when their human asks them to install): https://github.com/agenticmail/agenticmail/blob/main/AGENTS.md
* Research paper on structured RPC vs text based sub-agent orchestration: https://github.com/agenticmail/agenticmail/blob/main/research/agent-rpc-vs-spawn/paper.pdf

## License

MIT. See LICENSE.
