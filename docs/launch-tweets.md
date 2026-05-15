# Launch tweets — Claude Code + Codex integrations

Two separate long threads, one per host integration. Character counts noted inline so we stay under X's 280-char limit per post. Install instructions are NOT included on purpose — the call to action is "tell your agent to set it up", which then reads `AGENTS.md` and runs the bootstrap itself.

---

## Thread A — Claude Code (12 tweets)

### 1/12 (272 chars)

🎀 AgenticMail for Claude Code.

Stop spawning Task sub-agents that forget each other the second they return.

Spin up a real team of Claude Code agents — each with their own inbox, persona, memory, and audit trail — and let them coordinate by emailing each other.

A thread ↓

### 2/12 (276 chars)

The premise:

Sub-agents are good at "go do this one thing, come back with the answer."

They're terrible at "designer hands the spec to the builder hands the diff to the reviewer hands the bug back to the builder."

That second pattern is how humans build real software.

### 3/12 (275 chars)

So I asked Claude Code to build me a Facebook clone — full stack, real DB, seeded with 500 users, posts, comments, the 6 emoji reactions, friend graph, friend requests.

Solo run, one Claude Code session: it wrote everything in one giant turn, lost the schema halfway, gave up on auth.

### 4/12 (273 chars)

Then I tried it with AgenticMail.

4 agents on one email thread:
· Vesper — creative director
· Orion — backend
· Atlas — frontend
· Lyra — code reviewer

I CC'd all four on the kickoff email. `wake: ["vesper"]` — only Vesper gets a turn first.

She replied with the design doc.

### 5/12 (273 chars)

Vesper's reply CC'd everyone, body said "Orion — over to you for the schema", `wake: ["orion"]`.

The dispatcher daemon noticed the new mail in Orion's inbox via IMAP IDLE and spawned a fresh Claude Code turn for him. Orion read the full thread, then wrote the Postgres schema.

### 6/12 (272 chars)

Orion handed to Atlas. Atlas handed to Lyra. Lyra found a bug in Atlas's React + sent it back with `wake: ["atlas"]`.

24 hours later, no babysitting from me: working backend, working auth, friend graph, post timeline, the 6 emoji reactions, photo uploads. All in one project tree.

### 7/12 (276 chars)

The thing that makes this work: the thread IS the workspace.

Every agent reads the FULL thread before acting. They see who said what when. They check their own prior contributions to avoid re-doing work. They use `wake: [name]` to hand off cleanly.

No scheduler. No RPC. Just email.

### 8/12 (273 chars)

Why this beats spawning more Task sub-agents:

· Sub-agents lose state at end of turn. Email threads persist across restarts.
· Sub-agents can't talk to each other. Email lets them.
· Sub-agents leave you to glue their answers together. The thread IS the glue.

### 9/12 (270 chars)

Why this beats running 4 Claude Code windows in parallel:

· The 4 windows don't share state. You'd be copy-pasting between them.
· They can't wake each other. Slow human-in-the-loop coordination.
· You lose the audit trail — no single place that shows who decided what when.

### 10/12 (262 chars)

Operationally:

· Self-hosted. Real RFC-822 mail, local Stalwart server.
· Per-agent OAuth via your Claude Code session. No separate Anthropic key per agent.
· Rate-limit aware (1h backoff + retry).
· Restart-safe (cursor + memory persisted to disk).
· Web UI included.

### 11/12 (271 chars)

The cost story:

Without `wake`, every CC'd recipient would wake on every reply. 4 agents × 8 turns = 32 Claude calls.

With `wake: [name]`, only the next assignee thinks. Same 8 turns = 8 Claude calls.

That single field is the difference between "this is expensive" and "fine".

### 12/12 (188 chars)

To try it, just tell Claude Code:

> "set up AgenticMail for yourself"

It reads the AGENTS.md, runs the installer, wires the integration, restarts. Then send the first email.

→ github.com/agenticmail/agenticmail

---

## Thread B — OpenAI Codex CLI (12 tweets)

### 1/12 (271 chars)

🎀 AgenticMail for Codex.

Codex is great at one big task.

But "build me a LinkedIn clone" isn't one task — it's a designer + a backend dev + a frontend dev + a reviewer arguing over Slack for a week.

AgenticMail gives Codex that team. Real inboxes. Real handoffs. Real diffs.

A thread ↓

### 2/12 (272 chars)

What you actually want when you say "build me LinkedIn" is:

· One agent decides the data model
· Another stubs the API
· Another builds the React app against it
· Another writes the seed script + tests
· They argue when something doesn't line up

None of that fits in one Codex turn.

### 3/12 (272 chars)

So I told Codex: build LinkedIn. Profile pages, connection requests, feed, posts with reactions, search, messaging.

Solo Codex run, single session: 12k tokens in, it stalled around the time profile + posts + connections all needed to read each other. Lost the thread, gave up.

### 4/12 (276 chars)

Then I installed AgenticMail and gave Codex 4 teammates on one email thread:

· Kepler — backend + data model
· Marlow — frontend
· Rivet — auth + connections graph
· Sable — QA + seed scripts

`agenticmail-codex install --workspace ~/projects/linkedin` pinned all 4 to the same dir.

### 5/12 (272 chars)

The trick: every dispatcher-spawned Codex worker runs with the FULL native toolset.

Bash. File edit. Web fetch. Sandboxed to the project directory.

Marlow's file write lands at `frontend/src/Feed.tsx` on disk. Kepler's next turn reads that file and writes the matching route.

### 6/12 (271 chars)

So when Kepler says "shipped the /api/feed endpoint, here's the contract", he isn't pasting code into the email body.

He's saying: "the file is at backend/routes/feed.ts, types are at shared/types.ts, I added a curl example to README — Marlow, over to you."

Then `wake: ["marlow"]`.

### 7/12 (272 chars)

Marlow's worker spawns, reads the email, opens the files Kepler named, generates the React component against the real types, writes it to disk, replies with the path.

I never wrote a single line. The agents shipped 60+ files between them.

The email thread is the only place I read.

### 8/12 (273 chars)

Why this beats running 4 Codex sessions in 4 terminals:

· Sessions don't share project state. AgenticMail workers share a workspace.
· Sessions don't notify each other. The dispatcher wakes the next agent the moment mail lands.
· Sessions need 4 windows. This needs 1 + a web inbox.

### 9/12 (273 chars)

Why this beats Codex's built-in `spawn_agent`:

· `spawn_agent` workers can't talk to each other — they only report back to you.
· They lose all state at end of turn.
· No audit trail of decisions.

AgenticMail agents have inboxes. They reply-all. They remember. They sign their work.

### 10/12 (265 chars)

Codex specifics:

· Codex's hook ABI is literally byte-compatible with Claude Code (`ClaudeHooksEngine` in the Rust source 😅) — same hook scripts work.
· Workers ride on `@openai/codex-sdk`.
· Auto-approves AgenticMail MCP tools so worker turns don't get cancelled.

### 11/12 (276 chars)

You can co-install with Claude Code on the same machine.

`metadata.host` on every account routes to its own dispatcher. Claude-owned agents wake via Anthropic SDK. Codex-owned wake via OpenAI SDK. No dual-wake.

I run both. Different agents for different jobs. One unified web inbox.

### 12/12 (216 chars)

To try, just tell Codex:

> "set up AgenticMail for yourself, point the workspace at ~/projects/<your project>"

It reads AGENTS.md, registers the MCP server, hooks, dispatcher, restarts.

→ github.com/agenticmail/agenticmail
