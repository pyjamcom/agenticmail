import { defineConfig } from 'tsup';

/**
 * Why this exists in a config file rather than as inline CLI flags:
 *
 * tsup's CLI doesn't accept `--noExternal`, which we need to force
 * runtime dependencies (`@modelcontextprotocol/sdk`, `zod`) to be
 * inlined into the build output.
 *
 * The published package historically relied on a post-install `npm
 * install` step to fetch those deps. That breaks when the package is
 * installed by extracting a tarball directly (as @agenticmail/api's
 * dynamic loader does in production) or on hosts where node-gyp can't
 * compile native modules. Bundling the small JS deps removes that
 * fragility — `@agenticmail/core` stays external because it's already
 * deployed alongside us at known paths and bundling it would double
 * its footprint everywhere it's loaded.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  noExternal: ['@modelcontextprotocol/sdk', 'zod'],
});
