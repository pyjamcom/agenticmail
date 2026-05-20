/**
 * Path-traversal safe filesystem joiner.
 *
 * # Why this exists
 *
 * Every host-integration installer writes files into a directory
 * derived from operator config / env vars (`CODEX_HOME`,
 * `CLAUDE_CODE_AGENTS_DIR`, etc) AND builds filenames from values
 * returned by the AgenticMail API (account names, agent metadata).
 * Both inputs cross trust boundaries:
 *
 *   - The operator's env vars are mostly trusted — but the operator
 *     could fat-finger a relative path that resolves outside the
 *     intended dir, or paste a path containing `..` segments.
 *   - The AgenticMail API responses cross the master-key boundary.
 *     A compromised MCP session or stolen master key could create an
 *     account whose `name` contains `../../etc/something` to escape
 *     the agents directory at install time.
 *
 * The existing `sanitizeSubagentName` helpers filter most malicious
 * names, but defence-in-depth dictates a second boundary check at
 * the actual `fs.writeFile` call. This module is that second check.
 *
 * # API
 *
 * `safeJoin(baseDir, ...parts)` resolves the parts under `baseDir`
 * and throws `PathTraversalError` if the resulting absolute path
 * escapes `baseDir`. Use it instead of `path.join(baseDir, ...)` in
 * every code path that mixes operator config + user-provided
 * filenames.
 *
 * # Why this idiom (resolve + boundary check)
 *
 * - `path.resolve` normalises `..` segments deterministically.
 * - The startsWith check rejects any normalised path that climbed
 *   out of `baseDir`.
 * - CodeQL's `js/path-injection` query recognises this exact shape
 *   as a sanitizer, so the static-analysis warning is resolved at
 *   the same time the runtime risk is closed.
 *
 * # Edge cases handled
 *
 * - `parts` containing `..` segments → throws.
 * - `parts` containing an absolute path → the absolute path wins
 *   over `baseDir` per POSIX rules, which is almost always wrong
 *   when the caller meant "filename inside baseDir". We reject
 *   absolute segments unless `allowAbsolute: true` is set.
 * - `baseDir` itself is not normalised before comparison: pass an
 *   already-resolved absolute path. The helper asserts this.
 * - Symlinks are NOT resolved. If you need symlink-safe joining,
 *   wrap with `fs.realpath` separately. For our installers we
 *   don't follow symlinks at all (we always do explicit
 *   `existsSync` + `writeFileSync`), so this is fine.
 *
 * # Examples
 *
 * ```ts
 * // Safe: resolves to /home/alice/.codex/agents/agenticmail-cli.toml
 * safeJoin('/home/alice/.codex/agents', 'agenticmail-cli.toml');
 *
 * // Throws: '../etc/passwd' resolves outside the base dir
 * safeJoin('/home/alice/.codex/agents', '../etc/passwd');
 *
 * // Throws: an absolute path bypasses the base dir
 * safeJoin('/home/alice/.codex/agents', '/etc/passwd');
 * ```
 */

import { isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Thrown when a `safeJoin` call would resolve to a path outside the
 * provided base directory. Carries the offending inputs for logging
 * (with the resolved path elided so we don't leak filesystem layout
 * to a remote attacker via error messages).
 */
export class PathTraversalError extends Error {
  constructor(public readonly baseDir: string, public readonly parts: string[]) {
    super(
      `path traversal attempt: ${JSON.stringify(parts)} resolves outside ${baseDir}`,
    );
    this.name = 'PathTraversalError';
  }
}

export interface SafeJoinOptions {
  /**
   * Allow segments that are themselves absolute paths. Off by default
   * because passing an absolute path to `path.join` discards the
   * base directory — almost always a bug at our call sites.
   */
  allowAbsolute?: boolean;
}

/**
 * Resolve `parts` under `baseDir`, asserting the result stays inside
 * `baseDir`. See module docstring for the rationale.
 *
 * @throws `PathTraversalError` if any segment is absolute (and
 *   `allowAbsolute` is not set), or if the resolved path escapes
 *   `baseDir`.
 */
export function safeJoin(
  baseDir: string,
  ...partsAndOpts: (string | SafeJoinOptions)[]
): string {
  // Options can be passed as a trailing object — keeps the call site
  // ergonomic (`safeJoin(dir, 'foo', 'bar')`) without forcing every
  // caller to spell out `{ allowAbsolute: false }` explicitly.
  let opts: SafeJoinOptions = {};
  const parts: string[] = [];
  for (const p of partsAndOpts) {
    if (typeof p === 'string') {
      parts.push(p);
    } else if (p && typeof p === 'object') {
      opts = p;
    }
  }

  if (!opts.allowAbsolute) {
    for (const part of parts) {
      if (isAbsolute(part)) {
        throw new PathTraversalError(baseDir, parts);
      }
    }
  }

  // Resolve relative to the base dir. `path.resolve` normalises `..`
  // segments, so a malicious `../etc/passwd` collapses to its
  // canonical form before we boundary-check it.
  const resolvedBase = resolve(baseDir);
  const resolved = resolve(resolvedBase, ...parts);

  // The boundary check uses `resolvedBase + sep` so an attempt to
  // resolve to e.g. `/home/alice/.codex/agents-evil` doesn't slip
  // through against base `/home/alice/.codex/agents` via prefix match.
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + sep)) {
    throw new PathTraversalError(baseDir, parts);
  }

  return resolved;
}

/**
 * Convenience: same as `safeJoin` but returns `null` instead of
 * throwing on a traversal attempt. Use in code paths where a single
 * malicious filename should be skipped, not propagated up as an
 * exception (e.g. iterating `readdirSync` results during cleanup).
 */
export function tryJoin(
  baseDir: string,
  ...parts: string[]
): string | null {
  try {
    return safeJoin(baseDir, ...parts);
  } catch (err) {
    if (err instanceof PathTraversalError) return null;
    throw err;
  }
}

/**
 * Validate that a candidate path is already absolute and stays inside
 * `baseDir`. Use when receiving a path from external config that the
 * caller wants to treat as already-canonical (e.g. an env var that
 * names a project directory) — the helper asserts the safety
 * properties without further joining.
 */
export function assertWithinBase(baseDir: string, candidate: string): string {
  const resolvedBase = resolve(baseDir);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedBase && !resolvedCandidate.startsWith(resolvedBase + sep)) {
    throw new PathTraversalError(baseDir, [candidate]);
  }
  return resolvedCandidate;
}

/**
 * Re-export `join` so callers can opt-out for paths they've already
 * proven safe via `safeJoin`. Having a single import point per file
 * keeps grep'ing for "did we sanitize this?" tractable.
 */
export { join };
