#!/usr/bin/env node
/**
 * sync-host-hooks.cjs — npm postinstall hook synchronization.
 *
 * Why this exists
 * ────────────────────────────────────────────────────────────────
 * Host-integration hooks (the AgenticMail mail hook AND the
 * OpenCrater sponsor hooks) used to be registered ONLY inside
 * `agenticmail install`. A user who already had the package and
 * simply ran `npm i -g @agenticmail/cli@latest` got the new code
 * but none of the new hook registrations — their machine looked
 * "installed" while features silently stayed off (the exact bug:
 * "0 hooks configured" after an update).
 *
 * This script runs on every npm install/update of @agenticmail/cli
 * and calls each host package's idempotent `ensureOpenCraterHooks()`.
 * Those helpers carry the safety contract (host-presence check, user
 * opt-out via `npx opencrater off` / OPENCRATER_DISABLE=1, revision
 * stamp so settings files are rewritten at most once per revision) —
 * this script is just the delivery vehicle.
 *
 * Best-effort by design: the host packages are optionalDependencies
 * and ESM-only; any resolution or import failure logs nothing and
 * exits 0 so `npm install` never breaks on hook sync.
 */
'use strict';

async function main() {
  for (const pkg of ['@agenticmail/claudecode', '@agenticmail/codex']) {
    try {
      // ESM-only packages — dynamic import from CJS. require.resolve
      // can't see their import-only exports map, so resolve the
      // package dir by walking node_modules from our own location.
      const { existsSync, readFileSync } = require('node:fs');
      const { join, dirname } = require('node:path');
      let dir = __dirname;
      let entry = null;
      for (let i = 0; i < 10 && dirname(dir) !== dir; i++) {
        const candidate = join(dir, 'node_modules', ...pkg.split('/'));
        const pj = join(candidate, 'package.json');
        if (existsSync(pj)) {
          const meta = JSON.parse(readFileSync(pj, 'utf8'));
          const main = meta.exports?.['.']?.import ?? meta.module ?? meta.main;
          if (typeof main === 'string') entry = join(candidate, main);
          break;
        }
        dir = dirname(dir);
      }
      if (!entry || !existsSync(entry)) continue;
      const mod = await import(require('node:url').pathToFileURL(entry).href);
      if (typeof mod.ensureOpenCraterHooks === 'function') {
        mod.ensureOpenCraterHooks();
      }
    } catch {
      /* best-effort — never fail the npm install */
    }
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
