<p align="center">
  <img src="./docs/images/logo-200.png" alt="AgenticMail logo (pink bow)" width="160" />
</p>

# AGENTS.md — instructions for AI agents working with AgenticMail

> If you are an AI coding assistant (Claude Code, ChatGPT, Cursor, Aider,
> Codex, Devin, …) and you've landed in this repo, **read this file first.**
> It tells you exactly what to do when a human asks you to install, set
> up, or modify AgenticMail.

This file follows the [agents.md](https://agents.md) convention.

---

## 1. If the user asks you to install AgenticMail

**Pick one of these two paths. Don't ask the user which — pick A.**

```bash
# Option A (recommended): one-line curl installer
curl -fsSL https://raw.githubusercontent.com/agenticmail/agenticmail/main/install.sh | bash

# Option B: manual two-command install (use if curl-bash is blocked)
npm install -g @agenticmail/cli@latest
agenticmail bootstrap
```

Both paths do the same thing. The curl installer just adds a Node 22+
preflight check and prints platform-specific upgrade instructions if
Node is missing or too old. Pass `--dry-run` to the curl version
(`curl -fsSL … | bash -s -- --dry-run`) if the user wants to see what
it will do without executing.

`bootstrap` is a non-interactive pipeline
that:

1. Auto-installs Colima + Docker via `brew` (macOS) or `apt` (Linux)
   if they're missing. **No Docker Desktop, no GUI gates.**
2. Generates a master key and master config under `~/.agenticmail/`.
3. Starts the Stalwart mail server in a Colima/Docker container.
4. Registers a launchd / systemd unit so the API auto-starts on boot.
5. Provisions a default agent.
6. Waits for `GET http://127.0.0.1:3829/api/agenticmail/health` to
   return 200 (port read from config, never hardcoded).
7. Wires the Claude Code integration (`agenticmail claudecode`) —
   harmless no-op if Claude Code isn't installed.

External email relay (Gmail / custom domain) and SMS are deliberately
SKIPPED — those need user-owned credentials nobody else has. The
default install gives a fully working **local-only** AgenticMail
where agents email each other at `*@localhost`. The user can add
external mail any time later with `agenticmail setup` (interactive).

**Prereqs you can rely on being present** on a typical dev machine:
- Node.js 22+ (we use `node:sqlite`; no native compilation)
- `brew` (macOS) or `apt` / `yum` (Linux)

**Prereqs the user must install themselves** if missing:
- Node.js 22+ — if `node -v` shows `<22`, tell the user to install
  Node 22 (`brew install node@22` or `nvm install 22 && nvm use 22`).
  Do NOT try to run bootstrap on Node 20 — `@agenticmail/core@0.7.x`
  uses the built-in `node:sqlite` module which requires Node 22.

After `bootstrap` finishes, tell the user to **restart Claude Code**
(or whichever MCP-aware client they use) so the new MCP server entry
in `~/.claude.json` takes effect.

---

## 2. If the user asks you to use AgenticMail for multi-agent coordination

**This is the single most-misused thing in this codebase.** Read carefully.
The pattern below is provider-agnostic — it applies whether your host is
Claude Code, ChatGPT, Cursor, Grok, Aider, or any other MCP client.

AgenticMail agents are **persistent identities with their own inboxes,
API keys, personas, and audit trails**. They coordinate the way humans
do: in **shared email threads**, with everyone CC'd, taking turns
implicitly from context.

### Preferred pattern — single thread, CC everyone

This is how a human boss coordinates a small team and it is the right
primitive for AgenticMail too:

```
1. list_agents()                            // discover, or...
2. create_account({ name: "Vesper", role: "creative-director" })
   create_account({ name: "Orion",  role: "developer" })

3. send_email({
     to:   "vesper@localhost",                          // primary owner of step 1
     cc:   "orion@localhost, claudecode@localhost",     // teammates + yourself
     wake: ["vesper"],                                  // ★ only Vesper gets a Claude turn
     subject: "Build a small terminal game",
     text: [
       "Team —",
       "",
       "Vesper, please design a minimal terminal game (under ~80 LOC).",
       "Reply-all with the design doc when ready. When you hand off,",
       "name Orion in your reply and set wake: [\"orion\"] so only he wakes.",
       "",
       "Orion, once Vesper signs off, implement it and reply-all with the code.",
       "",
       "I (the host) will watch the thread and step in if needed.",
     ].join("\n"),
   })

4. list_inbox / read_email on your bridge inbox to watch progress.
   Or use check_activity() to see which agents the dispatcher has woken
   right now — answers "did Vesper actually start working?" in one call.
   Step in by reply-all'ing into the same thread whenever needed.

5. When the work is done, the last contributor (or you) sends a wrap-up
   reply with [FINAL] in the subject. The dispatcher stops waking anyone
   on further replies to that thread.
```

What happens under the hood:
- The mail server pushes an SSE wake-up to **every local recipient**
  the moment the email lands.
- The **`wake` allowlist** gates which of them actually get a Claude
  turn from the dispatcher. With `wake: ["vesper"]`, only Vesper
  wakes; Orion still receives the mail in his inbox but stays asleep.
  Without `wake`, every CC'd recipient wakes (the v0.8.x default).
- Each woken agent reads the **full thread**, sees who else is CC'd,
  and decides if it's their turn. The dispatcher also tells them to
  check their own prior contributions before redoing work.
- Thread continues until someone closes it with `[FINAL]` (etc.) in
  the subject, or no agent has anything to add. No RPC, no scheduler,
  no out-of-band protocol.

### `wake` is the single biggest token saver on large threads

Without it, every CC'd recipient gets a Claude turn on every reply.
15 agents on a thread × every reply = 15 Claude turns per round.
With `wake`, only the agents you name actually think; everyone else
still receives the mail but stays asleep until you explicitly name
them in a later wake list. Pass `wake: []` to deliver silently.
Omit `wake` entirely to keep the default "wake everyone CC'd" behaviour.

### Close threads when work is done

A wrap-up reply with `[FINAL]`, `[DONE]`, `[CLOSED]`, or `[WRAP]` in
the subject tells the dispatcher this thread is sealed — no more
wakes on any reply to it. Add it once, the cascade stops.

### When to use `call_agent` instead

Only when you need **one structured answer from one agent**, inline in
your current host turn. Examples: "what's the current count of unread
mail in Fola's inbox?", "produce a JSON list of contacts tagged
'investor'". For anything multi-step or multi-agent, prefer the thread.

### Wrong way (do not do this — regardless of host)

```
✗ create_account({ name: "Vesper" })
✗ <host>.spawn_sub_agent({ prompt: "You are Vesper the designer..." })
✗ send_email({ from: bridge, to: "orion@localhost",
               text: "<the brief your native sub-agent wrote>" })
```

That spawns a generic sub-agent under YOUR identity (no Vesper persona,
no Vesper mailbox, no audit trail) and then forges mail "from" Vesper.
The AgenticMail agent named "Vesper" never actually thought anything —
you just used her name as a label on a manually-shuttled message.

Equally wrong: serialising the work yourself with sequential
`call_agent` calls ("get Vesper's design, then call Orion with it").
That works but is fragile and slow. The thread pattern lets the
agents drive their own handoffs.

### Why this matters

- Every agent has **full context every time they wake** — they read
  the whole thread, not just the latest message.
- Turn-taking is implicit; no scheduler, no RPC ceremony.
- The thread is **searchable history**. The host sees everything.
- Bringing in another teammate later is just adding them to CC.
- Per-agent signatures, outbound guard, persona consistency, and
  audit trail all stay intact — everything you lose by roleplaying.

### TL;DR rule

> If the human says "have agents A and B coordinate", reach for
> `send_email` with everyone on CC. Let them take turns in the thread.
> Use `call_agent` only for one-shot RPC. Never reach for your host's
> native sub-agent tool with a roleplay prompt.

---

## 3. If the user asks you to set up the Claude Code integration

If AgenticMail is already installed (`agenticmail --version` works,
`curl -s http://127.0.0.1:3829/api/agenticmail/health` returns 200):

```bash
agenticmail claudecode
```

One command. It:
- Provisions a dedicated `claudecode` bridge agent inside AgenticMail
  (idempotent — reuses if already present)
- Writes an MCP server entry to `~/.claude.json`
- Generates one Claude Code subagent file per AgenticMail agent under
  `~/.claude/agents/agenticmail-<name>.md`
- Starts the dispatcher daemon under PM2 (PM2 must be installed;
  `npm install -g pm2` if missing)

Then tell the user to restart Claude Code.

To check current status: `agenticmail claudecode --status`.
To remove: `agenticmail claudecode --remove`.

---

## 4. If the user asks "what is AgenticMail" / "what does it do"

It's a self-hosted email + SMS platform for AI agents. Each agent
gets a real email address, an inbox, and an API key. Agents email
each other for coordination (real RFC-822 mail through a local
Stalwart server), and optionally email the public internet through
a Gmail relay or a custom domain.

The Claude Code integration (`@agenticmail/claudecode`, new in 0.7/0.8)
makes every AgenticMail agent callable as a native Claude Code subagent
via `Agent { subagent_type: "agenticmail-<name>" }`, AND auto-wakes
agents when mail arrives in their inbox (workers run inside the
user's existing Claude Code OAuth — no separate Anthropic key needed).

---

## 5. If the user asks you to verify it's working

```bash
agenticmail status                   # service health
agenticmail claudecode --status      # integration health
curl -s http://127.0.0.1:3829/api/agenticmail/health   # raw API health
```

Inside a fresh Claude Code session after restart:

```
Agent { subagent_type: "agenticmail-secretary", prompt: "what's your name and email?" }
```

The subagent should respond as the bridge agent ("secretary" by
default — or whatever default agent the bootstrap created).

---

## 6. If the user wants to see what their agents have been doing

Two surfaces, depending on whether they want **browser** or **terminal**:

### Browser — Gmail-style web UI

```bash
agenticmail web
```

Opens a three-pane Gmail-style UI at `http://127.0.0.1:3829/` —
agents on the left, inbox in the middle, full message with markdown
rendering on the right. Real-time SSE updates. Compose / reply with
the `wake` allowlist surfaced as a field. Master-key auth, stored
in the browser's localStorage. Best surface for non-technical users
and anyone who prefers a visual inbox.

### Terminal — interactive REPL

```bash
agenticmail shell
```

Same data, terminal interface. 44+ slash commands. Best for power
users, scripting hand-offs, and AI assistants running on the user's
behalf via the Bash tool.

### When to point the user where

| User said… | Right answer |
|---|---|
| "show me what my agents have been doing" | `agenticmail web` (or shell — both work) |
| "I want to read my emails" | `agenticmail web` |
| "let me see Fola's inbox" | `agenticmail web` |
| "check on the team" | `agenticmail web` |
| "audit the last hour" | `agenticmail web` or `agenticmail shell` |
| "I want a Gmail-like view" | `agenticmail web` |
| "have Fola reply to my last email from accounting" | MCP — `call_agent` or `Agent { subagent_type: "agenticmail-fola" }` |
| "coordinate Vesper and Orion on this build" | MCP — `send_email` with both on CC + `wake: ["vesper"]`, then `wait_for_email` |

Rule of thumb: **UI (web or shell) for monitoring by a human, MCP
for programmatic work driven by you.**

---

## 7. If something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| `agenticmail: command not found` after install | npm global bin not in `$PATH` | `echo $PATH \| grep $(npm bin -g)` — if missing, `export PATH="$(npm bin -g):$PATH"` |
| `npm install` fails on `node-gyp` / `better-sqlite3` | User is on `@agenticmail/cli@<0.8` (older release that still used `better-sqlite3`) | `npm install -g @agenticmail/cli@latest` — 0.7.x core uses `node:sqlite`, no native build |
| `Cannot find package 'sqlite'` at runtime | Node < 22 | Install Node 22+ (`brew install node@22`) |
| Stalwart container won't start | Colima not running | `colima start` then re-run `agenticmail bootstrap` |
| Bootstrap times out at Phase 3 | API server isn't coming up — usually means Stalwart's first-run init is slow | `tail -f ~/.agenticmail/logs/server.log` for the real error |
| Port `3829` already in use | Something else bound it | Edit `~/.agenticmail/config.json` to set `api.port` to a free port, then `agenticmail start` |

---

## 8. Repository layout (for agents modifying the code)

| Path | What it is |
|---|---|
| `packages/core/` | `@agenticmail/core` — DB layer, account/mail/gateway managers, spam filter, search index. Uses `node:sqlite` (Node 22+). |
| `packages/api/` | `@agenticmail/api` — Express REST API. Mounts integration routes when `@agenticmail/claudecode` is installed. |
| `packages/mcp/` | `@agenticmail/mcp` — MCP server (62 tools + `request_tools`/`invoke` meta-tools + `_account` per-call identity). |
| `packages/claudecode/` | `@agenticmail/claudecode` — Claude Code integration. Dispatcher daemon, persona engine, HTTP install endpoint, subagent .md generator. |
| `packages/openclaw/` | `@agenticmail/openclaw` — OpenClaw runtime integration. Older code path, still pinned to `@agenticmail/core@^0.5`. |
| `agenticmail/` | `@agenticmail/cli` — the user-facing `agenticmail` binary. Imports from `@agenticmail/api`, exposes `setup`, `bootstrap`, `start`, `claudecode`, `openclaw`, etc. |

## 9. Build / test / lint commands

```bash
npm install                                  # install all workspace deps
npm run build                                # build every workspace
npm run test                                 # run every workspace's tests
npm run build --workspace=@agenticmail/core  # build one package
npx vitest run -w packages/claudecode        # run one package's tests
```

Test counts as of `0.8.2`:
- `@agenticmail/core`: 339 specs
- `@agenticmail/claudecode`: 75 specs
- `@agenticmail/mcp`: 8 specs (catalogue audit)

## 10. Conventions to follow when contributing

- **ES modules everywhere.** No CommonJS.
- **Type imports** use `import { type X } from '...'` not `import type X from ...`.
- **Database access** goes through `Database` exported from
  `@agenticmail/core` (which is `node:sqlite`'s `DatabaseSync`). Do not
  add a `better-sqlite3` dependency back.
- **Default API port is `3829`.** If you need to hardcode a port
  somewhere, read it from `~/.agenticmail/config.json`'s `api.port`
  instead.
- **Engines `>=22` for all packages that depend on `@agenticmail/core`**
  (because of `node:sqlite`). Openclaw stays on `>=20` because it
  still depends on `@agenticmail/core@^0.5`.
- **Releases follow the `@agenticmail/cli` version**. Tag is `v<cli-version>`
  on GitHub. Commit message: `Release X.Y.Z: <short description>`.
- **CHANGELOG.md** at repo root uses Keep-a-Changelog format with
  `### Added` / `### Changed` / `### Fixed` sections. Update it on
  every release.

## 11. What NOT to do

- **Don't `npm install` random packages** to "fix" something. Most
  things are already wired correctly; if you can't find what you need,
  read the existing code first.
- **Don't add `better-sqlite3` back as a dependency.** The `node:sqlite`
  migration was deliberate and is documented in `CHANGELOG.md@0.8.2`.
- **Don't change the default port** without updating every README and
  the bootstrap pipeline.
- **Don't commit `package-lock.json` without regenerating it** —
  workspace version bumps require `npm install --package-lock-only`
  before commit, or CI will fail with `EUSAGE`.
- **Don't skip the CHANGELOG entry** when shipping a release.

## 12. Reference

- `README.md` — top-level overview, Quick Start, full feature list.
- `agenticmail/README.md` — CLI documentation, every command, every flag.
- `packages/<name>/README.md` — per-package docs (5 packages).
- `packages/<name>/REFERENCE.md` — exhaustive API reference for core / api / cli.
- `CHANGELOG.md` — every release ever.
- https://github.com/agenticmail/agenticmail — source.
- https://www.npmjs.com/org/agenticmail — published packages.
