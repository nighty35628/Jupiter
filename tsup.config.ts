import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
    outDir: "dist",
    noExternal: ["@jupiter/core-utils", "ink"],
  },
  {
    entry: ["src/cli/index.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    target: "node22",
    outDir: "dist/cli",
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; import { dirname as __j_dirname } from 'node:path'; import { fileURLToPath as __j_fileURLToPath } from 'node:url'; const __dirname = __j_dirname(__j_fileURLToPath(import.meta.url)); if (typeof globalThis.require === 'undefined') { globalThis.require = __cr(import.meta.url); }",
    },
    platform: "node",
    noExternal: [/.*/],
    esbuildOptions(opts) {
      opts.external = [...(opts.external ?? []), "react-devtools-core"];
    },
  },
  // Dashboard is now built by Vite (npm run build:dashboard).
  // The old tsup entry that bundled dashboard/app.js has been removed.
]);
