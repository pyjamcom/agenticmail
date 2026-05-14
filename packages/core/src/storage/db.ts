/**
 * SQLite storage layer for AgenticMail.
 *
 * Migrated from `better-sqlite3` to Node's built-in `node:sqlite` module
 * (stable since Node 22). The migration eliminates native compilation
 * entirely — `better-sqlite3` ships pre-built binaries per
 * NODE_MODULE_VERSION and intermittently lags new Node releases (Node
 * 25.5.0 was a real example: prebuilds missing, node-gyp fails on the
 * fallback compile-from-source path, fresh `npm install -g
 * @agenticmail/cli` fails for users on bleeding-edge Node). `node:sqlite`
 * is part of Node itself, so by definition it always matches the
 * runtime — no prebuilds, no gyp, no binding errors.
 *
 * # API shape differences this file accommodates
 *
 *   - `new DatabaseSync(path)` instead of `new Database(path)`.
 *   - No `db.pragma(x)` — use `db.exec("PRAGMA " + x)`.
 *   - No `db.transaction(fn)` — wrap in BEGIN/COMMIT manually (see
 *     `runTransactionally` below). Migrations are the only transaction
 *     site in core right now; if more callers need transactions later
 *     they should reuse the same helper.
 *   - `stmt.run(...)` still returns `{ changes, lastInsertRowid }`.
 *     One subtle gotcha: `lastInsertRowid` is a `bigint` in node:sqlite
 *     where better-sqlite3 returned a `number`. Consumers that compare
 *     with `===` or pass it to `Number(...)` need to be aware, but no
 *     site inside AgenticMail today does that — all our rowids are
 *     opaque or string-typed.
 *   - The class type is `DatabaseSync`; we re-export it as `Database`
 *     so consumer files can keep saying `Database` instead of plumbing
 *     `DatabaseSync` through everywhere.
 */

import { createRequire } from 'node:module';
import { ensureDataDir, type AgenticMailConfig } from '../config.js';

/**
 * Load Node's built-in sqlite module via `createRequire` rather than a
 * static `import { DatabaseSync } from 'node:sqlite'`.
 *
 * Why: esbuild (under tsup) normalises `node:sqlite` imports to plain
 * `sqlite` in the bundled output even when targeting `node22` — see
 * https://github.com/evanw/esbuild/issues/* (a known long-standing
 * quirk). The stripped form fails at runtime because there is no
 * userland `sqlite` package on disk. `createRequire(import.meta.url)`
 * runs at runtime and is opaque to esbuild's static analysis, so the
 * literal string `'node:sqlite'` is preserved verbatim and Node's
 * loader resolves it as the built-in.
 *
 * The type import stays static so we keep full IntelliSense on
 * DatabaseSync without paying for a separate type-only module.
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof import('node:sqlite').DatabaseSync>;

/**
 * Public type alias for the database instance. Consumers should
 * `import { type Database } from '@agenticmail/core'` rather than
 * importing from `node:sqlite` directly — this insulates them from any
 * future swap (back to better-sqlite3, or to a remote driver) without
 * a cascade of changes across the workspace.
 */
export type Database = DatabaseSync;

let db: Database | null = null;

export function getDatabase(config: AgenticMailConfig): Database {
  if (db) return db;

  ensureDataDir(config);
  const dbPath = `${config.dataDir}/agenticmail.db`;
  db = new DatabaseSync(dbPath);

  // Enable WAL mode for better concurrent access. node:sqlite doesn't
  // expose a .pragma() helper the way better-sqlite3 did, so we use
  // .exec() with raw PRAGMA statements. Effect is identical.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  runMigrations(db);
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Run `fn` inside a manual SQLite transaction.
 *
 * node:sqlite does NOT provide `db.transaction()` the way better-sqlite3
 * did, so we wrap a BEGIN/COMMIT pair around the callback. On any
 * synchronous throw we ROLLBACK and re-throw so the caller sees the
 * original error. Async callbacks are NOT supported here — node:sqlite
 * is sync-only by design, mirroring better-sqlite3's contract, and the
 * one transaction site in this file (migrations) is fully synchronous.
 */
function runTransactionally(database: Database, fn: () => void): void {
  database.exec('BEGIN');
  try {
    fn();
    database.exec('COMMIT');
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch { /* best effort */ }
    throw err;
  }
}

// Inline migration SQL so there's no filesystem dependency when bundled
const MIGRATIONS: Record<string, string> = {
  '001_init.sql': `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL UNIQUE,
  stalwart_principal TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY,
  stalwart_principal TEXT NOT NULL,
  dkim_selector TEXT,
  dkim_public_key TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key);
CREATE INDEX IF NOT EXISTS idx_agents_email ON agents(email);

CREATE VIRTUAL TABLE IF NOT EXISTS email_search USING fts5(
  agent_id,
  message_id,
  subject,
  from_address,
  to_address,
  body_text,
  received_at
);
`,
  '002_gateway.sql': `
CREATE TABLE IF NOT EXISTS gateway_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  mode TEXT NOT NULL DEFAULT 'none',
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchased_domains (
  domain TEXT PRIMARY KEY,
  registrar TEXT NOT NULL,
  cloudflare_zone_id TEXT,
  tunnel_id TEXT,
  dns_configured INTEGER NOT NULL DEFAULT 0,
  tunnel_active INTEGER NOT NULL DEFAULT 0,
  purchased_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  '003_agent_roles.sql': `
ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'secretary';
`,
  '004_dedup.sql': `
CREATE TABLE IF NOT EXISTS delivered_messages (
  message_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, agent_name)
);
`,
  '005_features.sql': `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT,
  email TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, email)
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  to_addr TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  cc TEXT,
  bcc TEXT,
  in_reply_to TEXT,
  refs TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
  text_content TEXT,
  html_content TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, name)
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, name)
);

CREATE TABLE IF NOT EXISTS scheduled_emails (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT,
  html_body TEXT,
  cc TEXT,
  bcc TEXT,
  send_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_agent ON contacts(agent_id);
CREATE INDEX IF NOT EXISTS idx_drafts_agent ON drafts(agent_id);
CREATE INDEX IF NOT EXISTS idx_signatures_agent ON signatures(agent_id);
CREATE INDEX IF NOT EXISTS idx_templates_agent ON templates(agent_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_agent ON scheduled_emails(agent_id, status);
`,
  '006_tags.sql': `
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#888888',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, name)
);

CREATE TABLE IF NOT EXISTS message_tags (
  agent_id TEXT NOT NULL,
  message_uid INTEGER NOT NULL,
  tag_id TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT 'INBOX',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, message_uid, tag_id, folder),
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tags_agent ON tags(agent_id);
CREATE INDEX IF NOT EXISTS idx_message_tags_agent ON message_tags(agent_id, tag_id);
CREATE INDEX IF NOT EXISTS idx_message_tags_uid ON message_tags(agent_id, message_uid, folder);
`,
  '007_agent_deletions.sql': `
CREATE TABLE IF NOT EXISTS agent_deletions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_email TEXT NOT NULL,
  agent_role TEXT,
  agent_created_at TEXT,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_by TEXT,
  reason TEXT,
  email_count INTEGER NOT NULL DEFAULT 0,
  report TEXT NOT NULL DEFAULT '{}',
  file_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_deletions_name ON agent_deletions(agent_name);
`,
  '008_rules.sql': `
CREATE TABLE IF NOT EXISTS email_rules (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  conditions TEXT NOT NULL DEFAULT '{}',
  actions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, name)
);
CREATE INDEX IF NOT EXISTS idx_email_rules_agent ON email_rules(agent_id, priority);
`,
  '009_agent_lifecycle.sql': `
ALTER TABLE agents ADD COLUMN last_activity_at TEXT;
ALTER TABLE agents ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0;
`,
  '010_tasks.sql': `
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  assigner_id TEXT NOT NULL,
  assignee_id TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'generic',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  completed_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON agent_tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigner ON agent_tasks(assigner_id, status);
`,
  '011_spam_log.sql': `
CREATE TABLE IF NOT EXISTS spam_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  message_uid INTEGER NOT NULL,
  score REAL NOT NULL,
  flags TEXT NOT NULL DEFAULT '[]',
  category TEXT,
  is_spam INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_spam_log_agent ON spam_log(agent_id, created_at);
`,
  '012_pending_outbound.sql': `
CREATE TABLE IF NOT EXISTS pending_outbound (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  mail_options TEXT NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_outbound_agent ON pending_outbound(agent_id, status);
`,
  '013_pending_notification_id.sql': `
ALTER TABLE pending_outbound ADD COLUMN notification_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_pending_notification ON pending_outbound(notification_message_id);
`,
  '014_task_output_schema.sql': `
-- Typed task contracts: when an assigner cares about the shape of the
-- deliverable, they can attach a JSON Schema describing what
-- submit_result must look like. The API validates against it before
-- accepting the result, so workers can't return free-form prose when
-- a structured object was requested.
--
-- Column is optional; NULL means "no schema, accept anything" (the
-- v0.8.x behaviour, fully back-compat).
ALTER TABLE agent_tasks ADD COLUMN output_schema TEXT;
`,
  '015_draft_attachments.sql': `
-- Persist attachments alongside their draft.
--
-- Stored as a JSON array on the row: each entry is
-- { filename, contentType, content (base64), size }. The web UI
-- cap is 20 MB total per draft, which SQLite handles fine without
-- bloating other queries — the column is only fetched on the
-- per-draft GET (not on the list endpoint) so the Drafts sidebar
-- stays snappy. NULL means "no attachments", fully back-compat
-- with rows from before this migration.
ALTER TABLE drafts ADD COLUMN attachments TEXT;
`,
};

function runMigrations(database: Database): void {
  // Ensure migrations tracking table exists
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const appliedStmt = database.prepare('SELECT name FROM _migrations');
  const applied = new Set(appliedStmt.all().map((r: any) => r.name as string));

  const insertStmt = database.prepare('INSERT INTO _migrations (name) VALUES (?)');

  // Sort migrations by name to ensure consistent ordering
  const sortedMigrations = Object.entries(MIGRATIONS).sort(([a], [b]) => a.localeCompare(b));

  // Run each migration in a transaction for atomicity. node:sqlite has
  // no transaction() helper, so we wrap manually via runTransactionally.
  for (const [name, sql] of sortedMigrations) {
    if (applied.has(name)) continue;
    runTransactionally(database, () => {
      database.exec(sql);
      insertStmt.run(name);
    });
  }
}

export function createTestDatabase(): Database {
  const testDb = new DatabaseSync(':memory:');
  testDb.exec('PRAGMA journal_mode = WAL');
  testDb.exec('PRAGMA foreign_keys = ON');

  for (const sql of Object.values(MIGRATIONS)) {
    testDb.exec(sql);
  }

  return testDb;
}
