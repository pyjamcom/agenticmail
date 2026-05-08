# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.58] - 2026-05-08

### Fixed

- **`POST /storage/tables` hangs indefinitely** (#15, thanks
  @kn8-codes). The storage routes were calling `db.run`, `db.get`,
  and `db.all` against a raw better-sqlite3 instance that only
  exposes `prepare/exec`. Every storage call threw a synchronous
  TypeError, and the one in `ensureMetaTable()` (which sat outside
  the per-route try/catch) escaped Express's default async handler
  — leaving the request hanging until the client timed out. Added
  an adapter that maps the async `run/get/all` shape to
  `prepare(sql).run/get/all(...args)` (and falls through to
  `exec(sql)` for parameter-less DDL like `CREATE TABLE`), so
  every storage endpoint now responds with success or a structured
  error.
- **SSE `/events` connects but never emits inbound mail events**
  (#16, thanks @kn8-codes). The `InboxWatcher` acquired a
  `getMailboxLock` and intentionally held it, expecting that to
  keep IDLE notifications flowing. ImapFlow's contract is the
  opposite — holding the lock keeps the connection in a command
  state and **prevents** IDLE from firing. Since the watcher's
  connection is dedicated to a single caller, the lock is now
  released immediately after the listeners are registered;
  `'exists'` / `'expunge'` / `'flags'` events now flow on every
  new mail and the SSE stream emits per the API docs.
- **Agent creation can fail with `fieldAlreadyExists` on the
  first attempt** (#17, thanks @kn8-codes). When a previous
  creation attempt left a Stalwart principal but no matching
  SQLite row (crash mid-create, manual cleanup, fresh re-install
  pointed at the same Stalwart), every subsequent
  `POST /accounts` would 500 with Stalwart's
  `fieldAlreadyExists` error. `AccountManager.create` now detects
  the orphan (no SQLite row but principal name in use) and
  deletes it before issuing the fresh `createPrincipal` call.
  The route handler also widens its 409 detection to recognise
  `fieldAlreadyExists` / `alreadyExists` so any unrelated
  Stalwart-flavoured "exists" error returns a clean 409 instead
  of falling through to the generic 500 path.
- **`agenticmail openclaw --help` launched the interactive setup
  wizard instead of showing usage** (#18, thanks @kn8-codes). The
  top-level CLI dispatcher only inspects `process.argv[2]`, so
  `openclaw --help` matched the openclaw case and dropped into
  the wizard. The handler now checks `process.argv.slice(3)` for
  `--help` / `-h` / `help` first and prints a sub-command help
  block with usage, the six setup steps, and a pointer back to
  the global help.
- **`agenticmail status` reported "Secure Tunnel ✅" on
  localhost-only setups** (#21, thanks @kn8-codes). The status
  command labelled the `cloudflared` dependency as "Secure
  Tunnel" and rendered it green whenever the binary was present
  — but the binary is downloaded as part of every setup,
  including localhost-only evals where no tunnel exists. The
  cloudflared row now only appears when the saved config has
  `gateway.mode === 'domain'` AND a tunnel id / domain is
  attached; otherwise it's hidden, and the actual tunnel state
  is left to the "Email" section to report from the live
  gateway-status endpoint. Renamed the friendly label to
  "Cloudflared CLI" for the cases where it does render so users
  understand we're surfacing CLI presence, not active tunnel
  health.

### Documentation

- Clarified the OpenClaw integration wording (#19, thanks
  @kn8-codes). The CLI README previously said
  "if OpenClaw is detected, automatically registers the plugin"
  inside the `agenticmail setup` step list; in practice plugin
  registration only happens through the explicit
  `agenticmail openclaw` flow. Reworded so that's unambiguous.
- Clarified async `call_agent` result delivery (#22, thanks
  @kn8-codes). The README's bullet on async mode implied an
  email always lands in the caller's inbox; clarified that the
  result email is dispatched through the normal mail pipeline,
  so on a localhost-only setup it shows up in the caller's
  local mailbox (`/mail/inbox`) rather than via SMTP relay.
- Surfaced #20's documentation gap list in the relevant places:
  the cloudflared download is now described as expected even on
  localhost-only setups; the storage API's failure-mode response
  shape is documented inline; the OpenClaw plugin verification
  troubleshooting steps got a paragraph in the OpenClaw README.

## [0.5.57] - 2026-05-07

### Changed

- **Renamed the CLI package from `agenticmail` to `@agenticmail/cli`.**
  GitHub Packages requires scoped names, so `agenticmail` (the only
  unscoped package in the monorepo) couldn't ship to
  `https://npm.pkg.github.com` alongside the rest of the
  `@agenticmail/*` workspaces. Renaming aligns the publish surface
  on both registries and makes the package set easier to manage as
  a single namespace. The CLI binary itself is still
  `agenticmail` — only the install name changed:
  `npm install -g @agenticmail/cli`.
  The legacy `agenticmail@0.5.56` package on npm stays available
  for in-flight installs but receives no further updates.

## [0.5.56] - 2026-05-07

### Added

- **`classifyEmailRoute` core helper + SSE route metadata** (#14).
  Inbound `/events` SSE messages now carry a `route` field tagging
  the email as one of `ignore_spam`, `ignore_newsletter`,
  `archive_automated`, `project_update`, `deal_escalation`,
  `agent_instruction`, or `human_private`. Each classification
  includes the suggested action (`ignore` / `archive` / `notify` /
  `escalate` / `create_task` / `draft_reply`), confidence
  (`low|medium|high`), human reason, and a `gateRequired` flag so
  downstream agents know when a route needs explicit human approval
  before acting. Pure function — attaches metadata, never auto-acts.
- **Configurable OpenClaw inbox injection** (#13). The plugin's
  unread-mail prompt context now has four modes:
  `inboxInjectionMode: off | count | summary | required` (default
  `summary`). The pre-0.5.56 hardcoded "ACTION REQUIRED, read every
  unread email first" prompt is preserved behind explicit
  `required` configuration; the new default surfaces sender +
  subject + UID metadata without forcing read-first behaviour.
  `inboxInjectionMaxItems` (1-25, default 5) and
  `inboxInjectionIncludePreview` (boolean, default false) round
  out the controls.

### Fixed

- **`mail.references` crashes when the value arrives as a string
  instead of an array** (#11, thanks @marcelomar21). Three call
  sites in `RelayGateway.sendViaRelay` and the gateway manager's
  inbound + outbound paths previously called `mail.references?.join`
  unconditionally, throwing `TypeError: mail.references?.join is
  not a function` for every reply where the upstream caller resolved
  a single `Message-Id` reference. Each site now guards with
  `Array.isArray(...)` and falls through to the raw string when
  it's already a flat header value.
- **CLI app-password prompts echoed Google Voice credentials in
  plaintext** (#12). The three setup paths that ask for a Gmail
  app password now use the existing `askSecret` masked-input
  helper, matching the rest of the CLI's secret-prompt vocabulary.
- **`@agenticmail/mcp` `apiRequest` returned `Promise<any>`**
  (#12). The helper is now generic (`apiRequest<T>`) and no
  longer leaks `any` into every tool implementation that calls it.

### Security

- **Hardened the OpenClaw inbox-injection summary against
  prompt-tag breakout.** The summary embeds untrusted email
  metadata (sender, subject, optional preview) inside an
  `<unread-emails>…</unread-emails>` block in the agent's system
  prompt. A hostile sender could previously close the block early
  and inject instructions below it. Sanitisation now strips `<`
  and `>` from every untrusted field plus caps the sender address
  (120 chars) and subject (160 chars) so a long header can't
  drown the rest of the prompt. Hardened on top of #13.
- **Scoped route-classifier metadata to the policy keys it
  actually reads.** The `/events` SSE route previously passed the
  full `agent.metadata` blob into the classifier. The classifier
  only consults `emailRoutePolicy / routePolicy / mailboxPolicy`,
  so we now project just those three keys. Prevents a future
  classifier-side change from accidentally echoing founder-set
  arbitrary metadata into the SSE event payload. Hardened on top
  of #14.

### Credits

Thanks to **@marcelomar21** for the relay-references array-guard
fix in #11, and to **@benediktkraus** for the public-quality
tightening in #12, the configurable inbox injection in #13, and
the inbound route classifier in #14. The detailed PR descriptions
and verification checklists made the security review + hardening
passes straightforward.

## [0.5.55] - 2026-05-02

### Fixed

- **`@agenticmail/mcp` crash on startup with MCP SDK 1.13+** (#9). The
  loose `^1.12.0` semver let npm install 1.13+ fresh, where tool
  registration tightened to require Zod schemas instead of raw JSON
  Schema. Added a JSON-Schema-to-Zod converter so the existing tool
  definitions register cleanly on every SDK release ≥ 1.12, and
  switched the tool callback signature to the post-1.13 `(args)`
  shape. Initial fix from @Abeyron in #8.
- **`db_admin` arrays silently rejected** — the converter previously
  fell back to `z.array(z.string())` for arrays without an explicit
  `items` declaration, which broke `columns`, `rows`, `operations`
  and other object-array inputs. Fallback is now `z.any()` for
  defence-in-depth, and every existing array field has explicit
  `items` so OpenAI-strict validators accept the schema upstream.
- **Free-form objects (`where`, `set`, `column`) rejected by the
  converter** — `z.object({})` rejected every real call. Now
  resolved to `z.record(z.any())` when `properties` is empty.
- **`cc` / `bcc` dropped on domain-mode sends** — `sendViaStalwart()`
  built a nodemailer envelope without the `cc`/`bcc` fields even
  though the upstream `SendMailOptions` carried them. Initial fix
  from @Abeyron in #8.
- **Inbound relay messages mis-attributed to the agent in domain
  mode** — `parseEmail()` only restored `X-Original-From` when the
  rewritten sender ended in `@localhost`. Now also matches messages
  carrying `X-AgenticMail-Relay: inbound`. Initial fix from
  @Abeyron in #8.
- **First-run setup fails with 404 on Stalwart admin** (#10). Pinned
  `stalwartlabs/stalwart` to `v0.15.5` in both the bundled
  `docker-compose.yml` and the `generateDockerFiles()` template
  (and the CI service). Stalwart 0.16+ moved its config to JSON
  at `/etc/stalwart/config.json`, runs as UID 2000, and silently
  ignores the legacy TOML mount, leaving the container in
  bootstrap mode. The wizard's setup error mapping now also
  recognises Stalwart 404s and points to issue #10 with the exact
  recovery commands.

### Credits

Thanks to **@Abeyron** for the original PR (#8) covering the MCP
schema, cc/bcc, and `X-Original-From` fixes, and to
**@StreamlinedStartup** for the detailed reproductions in #9 and #10
that made the root causes obvious.

## [0.2.26] - 2026-02-15

### Added

- **Domain mode** — full Cloudflare integration for custom domain email
  - Automatic DNS configuration (MX, SPF, DKIM, DMARC, tunnel CNAME)
  - Cloudflare Tunnel for secure inbound traffic
  - Email Worker deployment for Cloudflare Email Routing
  - Catch-all routing rule to forward all domain email to AgenticMail
  - DKIM signing via Stalwart
  - Gmail SMTP outbound relay option for residential IPs
  - Automatic @domain email alias addition for existing agents
  - DNS backup before modifications
- **Domain purchase** — search and buy domains via Cloudflare Registrar
- **Outbound guard** — blocks emails containing sensitive data (API keys, PII)
  and requires human (master key) approval
- **Owner approval via email reply** — reply "approve" or "reject" to notification
  emails to process blocked outbound emails
- **Spam filter** — rule-based scoring engine for inbound emails
  - Configurable threshold (default: 40)
  - Categories: phishing, scam, malware, commercial spam, social engineering
  - Runs on both relay inbound and SSE event streams
  - Skips internal agent-to-agent emails
- **Email rules** — per-agent filtering rules (move, delete, mark read)
- **Inbound webhook** — `POST /mail/inbound` endpoint for Cloudflare Email Workers
- **Gateway API routes** — setup, status, DNS, tunnel management
- **MCP tools** — domain setup, relay setup, gateway status, test email, domain purchase
- **OpenClaw tools** — matching set of gateway management tools
- **Shell commands** — `/spam`, `/rules`, `/pending`, `/digest`, `/relay`
- **Inbox enhancements** — body previews, arrow key navigation, unread markers, preview toggle
- **Retry logic** — 3-attempt retry on all interactive shell inputs

### Changed

- Spam threshold lowered from 50 to 40
- Lottery scam rule score increased from 15 to 25
- `isInternalEmail()` now checks replyTo domain to detect relay-rewritten emails
- Navigation bars use `[Esc] back` instead of `[q] back`
- Separator lines added above navigation bars in inbox and folder views

### Fixed

- Relay emails incorrectly classified as internal (score 0) due to @localhost rewrite
- SSE handler now checks `X-AgenticMail-Relay` header to identify relay emails
- Agent deletion with typo in name no longer cancels immediately (3 retries)

## [0.2.0] - 2026-01-15

### Added

- Initial relay mode — Gmail/Outlook IMAP polling and SMTP relay
- Account management — create, list, delete AI agents
- Local Stalwart mail server integration
- IMAP inbox watching with SSE event streaming
- MCP server for AI client integration
- OpenClaw plugin with skill definitions
- Interactive CLI shell with 30+ commands
- Task system — agent-to-agent RPC with SSE + polling
- Rate limiting and authentication middleware
