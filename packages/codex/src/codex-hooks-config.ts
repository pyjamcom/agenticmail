/**
 * Read / write / patch ~/.codex/hooks.json — the file Codex CLI reads
 * lifecycle hooks from.
 *
 * # Codex vs Claude Code
 *
 * Claude Code keeps hooks NESTED inside `~/.claude/settings.json` under
 * a `"hooks"` key alongside theme + preferences. Codex CLI puts them in
 * their own file at `<CODEX_HOME>/hooks.json` — cleaner separation,
 * easier to merge idempotently because we never touch user preferences.
 *
 * Discovery layers (from `codex-rs/hooks/src/engine/discovery.rs:289`):
 *
 *   $CODEX_HOME/hooks.json     — user-level (what we write)
 *   <repo>/.codex/hooks.json   — project-level
 *   system / MDM / plugin paths
 *
 * Hooks can also be declared inline under `[hooks]` in `config.toml` —
 * we deliberately use `hooks.json` instead because:
 *   1. JSON manipulation is lossless via Node's built-in `JSON.parse` /
 *      `JSON.stringify`; our TOML library reflows comments.
 *   2. `hooks.json` is a dedicated file, so merging our entries doesn't
 *      risk touching the user's MCP / model / sandbox config.
 *
 * # Wire schema (verbatim from Codex's `codex-rs/hooks/src/engine/mod_tests.rs:828`)
 *
 *   {
 *     "hooks": {
 *       "UserPromptSubmit": [
 *         {
 *           "matcher": "",
 *           "hooks": [{ "type": "command", "command": "node /path/to/mail-hook.js" }]
 *         }
 *       ],
 *       "SessionStart": [...],
 *       "Stop": [...]
 *     }
 *   }
 *
 * This is byte-for-byte the Claude Code hook schema. Codex's hook engine
 * crate in Rust is literally named `ClaudeHooksEngine` — OpenAI adopted
 * Anthropic's hook ABI.
 *
 * I/O contract for our mail-hook binary is also identical: read JSON on
 * stdin (carrying `hook_event_name`, `session_id`, `cwd`, etc.), write
 * JSON on stdout (with `hookSpecificOutput.additionalContext` for
 * UserPromptSubmit/SessionStart, or `decision:"block"` + `reason` for
 * Stop). The same `mail-hook.ts` runs unchanged across both hosts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Identify a hook command as ours. The bin name `agenticmail-codex-mail-hook`
 * is the canonical form (post-install resolves it via $PATH). We ALSO accept
 * the historical `mail-hook.js` substring so an older install where the
 * absolute-path form was written can be upserted without leaving stale
 * entries behind.
 */
function isAgenticMailHookCommand(command: string): boolean {
  if (typeof command !== 'string') return false;
  return (
    command.includes('agenticmail-codex-mail-hook') ||
    command.includes('agenticmail-mail-hook') ||
    command.includes('mail-hook.js')
  );
}

interface CodexHookCommand {
  type: 'command';
  command: string;
  /** Optional timeout in seconds — Codex respects this; Claude Code ignores it. */
  timeout?: number;
}

interface CodexHookRule {
  matcher?: string;
  hooks: CodexHookCommand[];
}

interface CodexHooksShape {
  hooks?: {
    UserPromptSubmit?: CodexHookRule[];
    Stop?: CodexHookRule[];
    SessionStart?: CodexHookRule[];
    PreToolUse?: CodexHookRule[];
    PostToolUse?: CodexHookRule[];
    PreCompact?: CodexHookRule[];
    PostCompact?: CodexHookRule[];
    PermissionRequest?: CodexHookRule[];
    [event: string]: CodexHookRule[] | undefined;
  };
  [key: string]: unknown;
}

/**
 * Hook events the AgenticMail mail-hook is registered on.
 *
 * Three events:
 *
 *   - **SessionStart** — fires on Codex `startup`, `resume`, AND `compact`.
 *     Output uses `hookSpecificOutput.additionalContext` to inject the
 *     AgenticMail capabilities blurb. Critically also fires after auto-
 *     compaction — session_id stays the same across compact, so a
 *     "once per session_id" dedup elsewhere would silently swallow the
 *     re-inject the model needs after context was wiped. SessionStart
 *     fires explicitly, so we re-emit cleanly.
 *
 *   - **UserPromptSubmit** — fires on every user prompt. Output uses
 *     `hookSpecificOutput.additionalContext` to inject the "you have
 *     new bridge mail" preamble before Codex reasons about the prompt.
 *     Also serves as a fallback channel for the capabilities blurb in
 *     case SessionStart didn't fire (older Codex builds, edge cases) —
 *     dedup'd per session_id so it's a no-op once SessionStart has
 *     already done its job.
 *
 *   - **Stop** — fires when Codex was about to end a turn. Output uses
 *     `decision: 'block'` + `reason` to force Codex to continue when
 *     there's unread bridge mail. This is the autonomous-mode awareness
 *     mechanism — long-running headless sessions where UserPromptSubmit
 *     never fires still wake on teammate replies at every natural
 *     turn boundary.
 *
 * Codex also exposes PreToolUse, PostToolUse, PreCompact, PostCompact,
 * and PermissionRequest. We don't register on those today. The remove
 * list is a superset so any earlier registrations on those events are
 * cleaned up automatically on the next upsert.
 */
const HOOK_EVENTS_TO_REGISTER = ['UserPromptSubmit', 'Stop', 'SessionStart'] as const;
const HOOK_EVENTS_TO_REMOVE = [
  'UserPromptSubmit',
  'Stop',
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
] as const;
type HookEvent =
  | typeof HOOK_EVENTS_TO_REGISTER[number]
  | typeof HOOK_EVENTS_TO_REMOVE[number];

function readHooks(path: string): CodexHooksShape {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as CodexHooksShape;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch (err) {
    throw new Error(
      `Could not parse Codex hooks file at ${path}: ${(err as Error).message}. ` +
      `Refusing to overwrite — please fix the file by hand and retry.`,
    );
  }
}

function writeHooks(path: string, settings: CodexHooksShape): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(settings, null, 2) + '\n';
  const tmp = `${path}.agenticmail-tmp`;
  writeFileSync(tmp, text, 'utf-8');
  // Atomic POSIX rename → never leaves a half-written hooks file.
  renameSync(tmp, path);
}

/**
 * Insert (or replace) the AgenticMail mail-hook on every event we register on.
 * Returns `true` if the file changed.
 *
 * `command` is the shell command to run on each fire — typically the bin
 * name `agenticmail-codex-mail-hook` (resolves via $PATH after global
 * install), but can be a full path for tests or unusual setups.
 *
 * Each event gets its own rule with an empty `matcher` (matches all fires
 * of that event). The rule is identified for upsert/remove via the
 * `isAgenticMailHookCommand` substring check, so users can add their own
 * hooks on the same events without us disturbing each other.
 */
export function upsertMailHook(path: string, command: string): boolean {
  const settings = readHooks(path);
  if (!settings.hooks) settings.hooks = {};

  let changed = false;

  for (const event of HOOK_EVENTS_TO_REGISTER) {
    if (upsertOneEvent(settings.hooks, event, command)) changed = true;
  }

  // Heal earlier installs: any historical event we registered on but no
  // longer do gets cleaned up here. Keeps the file from accumulating dead
  // entries across upgrades.
  for (const event of HOOK_EVENTS_TO_REMOVE) {
    if ((HOOK_EVENTS_TO_REGISTER as readonly string[]).includes(event)) continue;
    if (removeOneEvent(settings.hooks, event)) changed = true;
  }

  if (changed) writeHooks(path, settings);
  return changed;
}

function removeOneEvent(
  hooks: NonNullable<CodexHooksShape['hooks']>,
  event: HookEvent,
): boolean {
  const list = hooks[event] ?? [];
  if (list.length === 0) return false;
  const filtered = list.filter(rule =>
    !rule.hooks?.some(h => isAgenticMailHookCommand(h.command)),
  );
  if (filtered.length === list.length) return false;
  if (filtered.length === 0) delete hooks[event];
  else hooks[event] = filtered;
  return true;
}

function upsertOneEvent(
  hooks: NonNullable<CodexHooksShape['hooks']>,
  event: HookEvent,
  command: string,
): boolean {
  const list = hooks[event] ?? [];

  const isOurs = (rule: CodexHookRule): boolean =>
    rule.hooks?.some(h => isAgenticMailHookCommand(h.command)) ?? false;

  const desired: CodexHookRule = {
    matcher: '',
    hooks: [{ type: 'command', command }],
  };

  const existingIdx = list.findIndex(isOurs);
  if (existingIdx >= 0) {
    const existing = list[existingIdx];
    if (
      existing.matcher === desired.matcher &&
      existing.hooks.length === desired.hooks.length &&
      existing.hooks.every((h, i) => h.command === desired.hooks[i].command)
    ) {
      return false;
    }
    list[existingIdx] = desired;
  } else {
    list.push(desired);
  }
  hooks[event] = list;
  return true;
}

/**
 * Remove the AgenticMail mail-hook from every Codex event we registered
 * it on. Only our rules are touched — any other hooks the user has
 * installed under the same events are preserved.
 *
 * Returns `true` if the file changed.
 */
export function removeMailHook(path: string): boolean {
  if (!existsSync(path)) return false;
  const settings = readHooks(path);
  if (!settings.hooks) return false;

  let changed = false;
  for (const event of HOOK_EVENTS_TO_REMOVE) {
    if (removeOneEvent(settings.hooks, event)) changed = true;
  }

  // Tidy up: drop the empty hooks key if nothing's left.
  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (changed) writeHooks(path, settings);
  return changed;
}
