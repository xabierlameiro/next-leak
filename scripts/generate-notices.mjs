#!/usr/bin/env node
// dist/ ships third-party code inlined by esbuild — 88 packages at the time of
// writing, not the 9 named in tsup's `noExternal` list, because their
// transitive trees come along. MIT, ISC, BSD and Apache-2.0 all require the
// copyright notice to travel with the distribution, and `files: ["dist"]`
// carried none of them.
//
// The set is derived from the build's own metafile rather than kept by hand:
// a hand-written list is wrong the first time a dependency shifts, and being
// quietly wrong is the failure this file exists to prevent.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = path.join(rootDir, "dist");
const metafilePath = path.join(distDir, "metafile-esm.json");
const outputPath = path.join(rootDir, "THIRD-PARTY-NOTICES.md");

let metafile;
try {
  metafile = JSON.parse(readFileSync(metafilePath, "utf8"));
} catch {
  console.error(
    `✖ notices FAILED: ${path.relative(rootDir, metafilePath)} is missing.\n` +
      `  It is written by tsup (metafile: true) — run the build before this script.`
  );
  process.exit(1);
}

/**
 * Package directory for a bundled input, taken from the path esbuild recorded.
 *
 * Deriving it from the input path rather than resolving the name from the repo
 * root matters under pnpm: the same package can appear at several versions,
 * and only the recorded path says which one was inlined.
 */
function packageRootOf(input) {
  const marker = "node_modules/";
  const index = input.lastIndexOf(marker);
  if (index === -1) {
    return null; // our own source
  }
  const after = input.slice(index + marker.length).split("/");
  const segments = after[0]?.startsWith("@") ? after.slice(0, 2) : after.slice(0, 1);
  if (segments.length === 0 || segments.some((segment) => segment === undefined)) {
    return null;
  }
  return {
    name: segments.join("/"),
    dir: path.join(rootDir, input.slice(0, index + marker.length), ...segments),
  };
}

const packages = new Map();
for (const input of Object.keys(metafile.inputs)) {
  const found = packageRootOf(input);
  if (found !== null && !packages.has(found.name)) {
    packages.set(found.name, found.dir);
  }
}

// Covers LICENSE, LICENCE.md, COPYING, NOTICE, and the LICENSE-MIT.txt form
// several packages use.
const LICENSE_FILENAMES = /^(licen[cs]e|copying|notice)([.-][\w.-]*)?$/i;

function readLicenseText(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const match = entries.find((entry) => LICENSE_FILENAMES.test(entry));
  if (match === undefined) {
    return null;
  }
  return readFileSync(path.join(dir, match), "utf8").trim();
}

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

const notices = [];
const unknown = [];
for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const manifest = readManifest(dir);
  const declared = typeof manifest.license === "string" ? manifest.license : null;
  const text = readLicenseText(dir);
  const homepage = manifest.homepage ?? manifest.repository?.url ?? null;

  // A package with neither a notice file nor a declared licence is the case
  // this script exists to catch: we would be redistributing code on unknown
  // terms. Stop the build rather than ship a notices file that looks complete.
  if (text === null && declared === null) {
    unknown.push(name);
    continue;
  }

  notices.push({
    name,
    version: manifest.version ?? "unknown",
    license: declared ?? "see text below",
    homepage,
    // Some packages declare a licence but ship no notice file. Say so, rather
    // than inventing a copyright line nobody wrote.
    text:
      text ??
      `Upstream ships no licence file. Declared licence: ${declared}.` +
        (homepage === null ? "" : `\nSee ${homepage} for the authoritative text.`),
  });
}

if (unknown.length > 0) {
  console.error(
    `✖ notices FAILED: ${unknown.length} bundled package(s) declare no licence ` +
      `and ship no notice:\n  ${unknown.join("\n  ")}\n` +
      `  next-leak inlines them into dist/, so their terms have to be known.\n` +
      `  Check the package, or stop bundling it.`
  );
  process.exit(1);
}

const body = notices
  .map((notice) => {
    const link = notice.homepage === null ? "" : `\n${notice.homepage}`;
    return (
      `## ${notice.name}@${notice.version}\n\n` +
      `License: ${notice.license}${link}\n\n` +
      "```\n" +
      notice.text.replaceAll("```", "'''") +
      "\n```"
    );
  })
  .join("\n\n---\n\n");

writeFileSync(
  outputPath,
  `# Third-party notices\n\n` +
    `next-leak bundles its dependencies into \`dist/\` at build time so that\n` +
    `installing it does not pull a headless browser onto your machine — see\n` +
    `[SECURITY.md](./SECURITY.md) for why. The licences of everything inlined\n` +
    `are reproduced below.\n\n` +
    `This file is generated by \`scripts/generate-notices.mjs\` from the build's\n` +
    `own metafile. Do not edit it by hand.\n\n` +
    `${notices.length} bundled packages.\n\n---\n\n${body}\n`
);

// Build metadata, not something a consumer should download: `files: ["dist"]`
// would otherwise publish a third of a megabyte of it.
rmSync(metafilePath, { force: true });

console.log(`✔ THIRD-PARTY-NOTICES.md written — ${notices.length} bundled packages`);
