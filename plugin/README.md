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
