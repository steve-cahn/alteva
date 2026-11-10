// Bundles the service in the current directory into one file, dist/index.mjs, with every dependency
// (and the workspace's `@alteva/core`) inlined. The production image then needs no node_modules, no
// TypeScript and no pnpm: just Node and this file. Run it with `pnpm --filter <service> build`.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true, // run with --enable-source-maps for readable stack traces
  external: ["pg-native"], // pg's optional native binding: not installed, never used
  // Some bundled CommonJS dependencies call require() on Node built-ins; ESM has none, so provide one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "info",
});
