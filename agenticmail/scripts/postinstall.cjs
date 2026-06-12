#!/usr/bin/env node
/**
 * postinstall.cjs — single cross-platform postinstall entry point.
 *
 * npm runs scripts through cmd.exe on Windows, where `;` is not a
 * command separator and `true` is not a command — so chaining steps
 * in the script string breaks exactly on the platform that needs the
 * hook sync most. This wrapper runs every step in-process instead,
 * each one isolated and best-effort, and always exits 0 so an
 * npm install/update can never be aborted by a convenience step.
 *
 * Steps:
 *   1. ensure-pm2-startup — PM2 resurrection on reboot (macOS plist fix)
 *   2. sync-host-hooks    — (re)register host-integration hooks so users
 *                           who merely npm-update get them without
 *                           re-running `agenticmail install`
 */
'use strict';

const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

for (const [script, args] of [
  ['ensure-pm2-startup.cjs', ['--quiet']],
  ['sync-host-hooks.cjs', []],
]) {
  try {
    spawnSync(process.execPath, [join(__dirname, script), ...args], {
      stdio: 'ignore',
      timeout: 60_000,
    });
  } catch {
    /* best-effort */
  }
}
process.exit(0);
