/**
 * Tiny wrapper that re-exposes a transitive host-integration CLI as a
 * top-level bin under `@agenticmail/cli`.
 *
 * # Why this exists
 *
 * `@agenticmail/cli` declares `@agenticmail/claudecode` and
 * `@agenticmail/codex` in `optionalDependencies` so a single
 * `npm install -g @agenticmail/cli` pulls in every host integration's
 * code. BUT npm only symlinks the bins of the DIRECTLY-installed
 * package into the global bin dir — transitive deps' bins stay
 * buried in `<global>/node_modules/@agenticmail/cli/node_modules/...`
 * and never land on `$PATH`.
 *
 * So a user running `npm install -g @agenticmail/cli@latest` could
 * call `agenticmail` but not `agenticmail-claudecode` or
 * `agenticmail-codex` — even though the code was right there. They'd
 * have to ALSO `npm install -g @agenticmail/claudecode @agenticmail/codex`
 * to surface those bins, which defeats the "one install" UX.
 *
 * This shim solves it: `@agenticmail/cli` declares its OWN
 * `agenticmail-claudecode` and `agenticmail-codex` bins (pointing at
 * compiled wrappers built from this file). Each wrapper resolves the
 * transitive package's actual bin path via Node's package.json
 * resolution and re-execs it.
 *
 * The wrapper preserves exit codes and pipes stdio through, so the
 * UX is identical to invoking the transitive bin directly — same help,
 * same prompts, same output, just discoverable on PATH.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

interface HostPackageJson {
  name?: string;
  bin?: Record<string, string> | string;
}

/**
 * Locate a transitive package's `package.json` by walking up from the
 * shim's own location through every `node_modules/<hostPkgName>/`
 * candidate.
 *
 * We do this filesystem-only discovery instead of
 * `require.resolve('${hostPkgName}/package.json')` or
 * `require.resolve(hostPkgName)` because:
 *
 *   1. The host packages' `exports` blocks don't whitelist
 *      `./package.json`, so that subpath lookup fails.
 *   2. The host packages' `exports['.']` only declares an `import`
 *      condition (they're ESM-only), so CJS-flavored
 *      `createRequire().resolve(hostPkgName)` fails with "No exports
 *      main defined" — CJS resolution can't satisfy an `import`-only
 *      exports block.
 *
 * Walking the filesystem bypasses the exports gate entirely and works
 * against already-published versions of the host packages without
 * requiring any republish.
 */
function findHostPackageJson(hostPkgName: string): string {
  // Walk from the compiled shim's location upward, checking each
  // ancestor's `node_modules/<hostPkgName>/package.json`.
  const startDir = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(startDir);
  let dir = startDir;
  while (true) {
    const candidate = join(dir, 'node_modules', hostPkgName, 'package.json');
    if (existsSync(candidate)) return candidate;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`${hostPkgName} is not installed (no node_modules/${hostPkgName} above ${startDir})`);
}

/**
 * Resolve the absolute path to a transitive host-integration package's
 * named bin entry.
 *
 * Throws a clear error message (caught by main()) when the host
 * package isn't installed — happens if the user has done something
 * weird like `npm install -g @agenticmail/cli --no-optional`.
 */
function resolveHostBin(hostPkgName: string, binName: string): string {
  const pkgJsonPath = findHostPackageJson(hostPkgName);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as HostPackageJson;
  const binField = pkg.bin;
  let binRelPath: string | undefined;
  if (typeof binField === 'string') {
    binRelPath = binField;
  } else if (binField && typeof binField === 'object') {
    binRelPath = binField[binName];
  }
  if (!binRelPath) {
    throw new Error(
      `${hostPkgName} is installed but doesn't declare a "${binName}" bin entry. ` +
      `This is likely a packaging mismatch — try \`npm install -g ${hostPkgName}@latest\`.`,
    );
  }
  const pkgDir = dirname(pkgJsonPath);
  return isAbsolute(binRelPath) ? binRelPath : join(pkgDir, binRelPath);
}

/**
 * Re-exec the transitive bin with the wrapper's argv + inherited stdio.
 * Exit code passes through verbatim so `set -e` / CI scripts behave the
 * same whether they invoked the wrapper or the real bin.
 */
export function runHostBin(hostPkgName: string, binName: string): never {
  let target: string;
  try {
    target = resolveHostBin(hostPkgName, binName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ ${msg}`);
    console.error(`  To install ${hostPkgName} directly:  npm install -g ${hostPkgName}@latest`);
    process.exit(127);
  }
  const child = spawn(process.execPath, [target, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      // Mirror the child's signal — bash convention is exit code 128+N
      // where N is the signal number, but Node maps that automatically
      // when we kill ourselves with the same signal. Cleanest path:
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
  child.on('error', (err) => {
    console.error(`✗ Failed to launch ${target}: ${(err as Error).message}`);
    process.exit(1);
  });
  // Forward common signals so Ctrl+C / SIGTERM reach the child cleanly.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      try { child.kill(sig); } catch { /* child may already be dead */ }
    });
  }
  // Never reached — child.on('exit') always fires. Keep TS happy.
  return undefined as never;
}
