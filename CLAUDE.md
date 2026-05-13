# Claude Code instructions for AgenticMail

This file is read by Claude Code when working in this repository.

**For all instructions, see [`AGENTS.md`](./AGENTS.md)** — the tool-agnostic
[agents.md](https://agents.md) file used by every major AI coding assistant
(Claude Code, ChatGPT, Cursor, Aider, Codex, …).

Quick reference for the most common asks:

**"Install AgenticMail":**

```bash
# Option A — one-line installer (recommended)
curl -fsSL https://raw.githubusercontent.com/agenticmail/agenticmail/main/install.sh | bash

# Option B — manual
npm install -g @agenticmail/cli@latest && agenticmail bootstrap
```

Either path: zero prompts, ~2 minutes. See [`AGENTS.md`](./AGENTS.md)
section 1 for the full runbook.

**"Show me what my agents have been doing":** point them at the
Gmail-style web UI or the interactive REPL — both work.

```bash
agenticmail web      # opens http://127.0.0.1:3829/ in the browser
agenticmail shell    # interactive terminal REPL
```

See [`AGENTS.md`](./AGENTS.md) section 6 for the decision table.

**"Coordinate two or more agents":** use the email-thread pattern.
One kickoff email, everyone on CC, `wake: ["alice"]` to scope which
agents actually get a Claude turn from the dispatcher. Add `[FINAL]`
to the subject to close the thread. See [`AGENTS.md`](./AGENTS.md)
section 2 for the worked example.
