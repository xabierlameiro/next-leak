#!/usr/bin/env node
// Release gate for the claim SECURITY.md makes out loud: "the published
// package cannot launch or download a browser, by construction". That rested
// entirely on three alias lines in tsup.config.ts, with nothing to catch a
// memlab upgrade that loads browser tooling down a path the alias misses.
//
// The alias can fail in three distinguishable ways, so there are three checks:
//   1. it stops matching        -> the stub is no longer in the bundle
//   2. the import stays external -> a bare require("puppeteer") survives
//   3. real puppeteer is inlined -> browser runtime strings appear, and the
//                                   bundle grows by megabytes
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Defaults to this repo's build; pack-smoke passes the *installed* package's
// dist, so the gate also runs against what a stranger actually downloads.
const rootDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = process.argv[2] ?? path.join(rootDir, "dist");

const failures = [];
const fail = (message) => failures.push(message);

let jsFiles;
try {
  jsFiles = readdirSync(distDir).filter((entry) => entry.endsWith(".js"));
} catch {
  console.error("✖ bundle check FAILED: dist/ is missing — run `pnpm build` first");
  process.exit(1);
}
if (jsFiles.length === 0) {
  console.error("✖ bundle check FAILED: dist/ contains no JavaScript");
  process.exit(1);
}

const sources = jsFiles.map((file) => ({
  file,
  code: readFileSync(path.join(distDir, file), "utf8"),
}));
const bundle = sources.map((source) => source.code).join("\n");

// 1. The stub's own message. Present only if the alias resolved to it, so its
//    absence means memlab is reaching browser tooling some other way.
const STUB_MARKER = "Heap-snapshot parsing must never reach puppeteer/xvfb";
if (!bundle.includes(STUB_MARKER)) {
  fail(
    `the browser stub is not in the bundle (no "${STUB_MARKER}").\n` +
      `    The esbuild alias in tsup.config.ts no longer matches how memlab loads\n` +
      `    browser tooling — real puppeteer/xvfb may now be reachable.`
  );
}

// 2. A bare import/require of the browser packages. esbuild leaves these
//    verbatim when it cannot resolve them, so the install would either drag
//    Chrome in or crash at runtime.
const BROWSER_PACKAGES = ["puppeteer", "puppeteer-core", "xvfb"];
const unresolved = new RegExp(
  String.raw`(?:require|import)\s*\(?\s*["'](${BROWSER_PACKAGES.join("|")})["']`,
  "g"
);
for (const { file, code } of sources) {
  for (const match of code.matchAll(unresolved)) {
    fail(`dist/${file} still imports "${match[1]}" — the alias did not apply to it`);
  }
}

// 3. Strings that exist in real browser tooling but not in memlab's references
//    to its own config. If any of these show up, puppeteer itself got inlined.
const BROWSER_RUNTIME_MARKERS = [
  "BrowserFetcher",
  "chrome-headless-shell",
  "PUPPETEER_DOWNLOAD_BASE_URL",
  "PUPPETEER_SKIP_DOWNLOAD",
  ".local-chromium",
];
for (const marker of BROWSER_RUNTIME_MARKERS) {
  if (bundle.includes(marker)) {
    fail(`dist/ contains "${marker}" — real browser tooling was bundled, not the stub`);
  }
}

// A backstop for anything the string checks miss: puppeteer-core alone is
// several megabytes, so it cannot arrive quietly.
const MAX_BUNDLE_MB = 5;
const totalBytes = jsFiles.reduce(
  (sum, file) => sum + statSync(path.join(distDir, file)).size,
  0
);
const totalMb = totalBytes / (1024 * 1024);
if (totalMb > MAX_BUNDLE_MB) {
  fail(
    `dist/ is ${totalMb.toFixed(2)} MB of JavaScript, over the ${MAX_BUNDLE_MB} MB ceiling.\n` +
      `    Something large was pulled in — check whether it is browser tooling before\n` +
      `    raising this limit.`
  );
}

if (failures.length > 0) {
  console.error("✖ bundle check FAILED:");
  for (const failure of failures) {
    console.error(`  · ${failure}`);
  }
  process.exit(1);
}

console.log(
  `✔ bundle check OK — browser tooling stubbed, ${totalMb.toFixed(2)} MB across ` +
    `${jsFiles.length} files`
);
