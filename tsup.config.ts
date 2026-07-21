import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts", "src/bootstrap.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  clean: true,
  // The memlab family drags puppeteer/xvfb (a full Chrome download) into
  // consumer installs. Bundle the heap-parsing code we actually use at build
  // time instead; browser tooling stays external and must never load.
  // autocannon is bundled for a different reason: its transitive tree ships a
  // moderate uuid vulnerability (GHSA-w5hq-g745-h8pq via hyperid) with no fix
  // available upstream. Our own tree patches it via the pnpm override
  // (uuid >= 11.1.1), but overrides do not propagate to consumers — bundling
  // ships the patched tree and shrinks the install from 67 packages to a few.
  noExternal: [
    /^@memlab\//,
    "autocannon",
    "fs-extra",
    "chalk",
    "ansi",
    "babar",
    "minimist",
    "string-width",
    "util.promisify",
  ],
  esbuildOptions(options) {
    // memlab loads browser tooling eagerly at module init; alias it to a
    // loud stub so the published package never depends on puppeteer/Chrome.
    options.alias = {
      ...options.alias,
      puppeteer: "./src/stubs/browser-stub.cjs",
      "puppeteer-core": "./src/stubs/browser-stub.cjs",
      xvfb: "./src/stubs/browser-stub.cjs",
    };
  },
  banner: {
    // Bundled CJS (memlab) uses dynamic require of Node builtins, which the
    // esbuild ESM shim rejects — provide a real require in module scope.
    js:
      "import { createRequire as __nextLeakCreateRequire } from 'node:module';" +
      "import { fileURLToPath as __nextLeakFileURLToPath } from 'node:url';" +
      "import { dirname as __nextLeakDirname } from 'node:path';" +
      "const require = __nextLeakCreateRequire(import.meta.url);" +
      "const __filename = __nextLeakFileURLToPath(import.meta.url);" +
      "const __dirname = __nextLeakDirname(__filename);",
  },
});
