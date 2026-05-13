import { defineConfig } from 'tsup';

/**
 * tsup/esbuild configuration for @agenticmail/core.
 *
 * Two non-default settings matter here:
 *
 *   1. `target: 'node22'`. We import `node:sqlite` (Node 22+ stdlib),
 *      and esbuild's older default target strips the `node:` prefix on
 *      built-in imports, producing `import { ... } from "sqlite"` —
 *      which then fails at runtime because there is no package named
 *      "sqlite" on disk. Setting target to node22 keeps the prefix
 *      intact AND enables modern syntax (top-level await, etc.) we'd
 *      otherwise have to polyfill.
 *
 *   2. `external: ['node:*']`. Belt-and-suspenders — explicitly mark
 *      every `node:`-prefixed import as an external dependency so
 *      esbuild never tries to bundle or rename it. Pairs with the
 *      target setting to fully insulate built-in module imports.
 *
 * Everything else (entry, format, dts, clean) mirrors what the previous
 * inline `tsup` CLI invocation in package.json was doing.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node22',
  external: ['node:*'],
});
