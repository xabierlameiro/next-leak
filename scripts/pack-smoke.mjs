#!/usr/bin/env node
// Release gate: pack the real tarball, install it in a clean directory, and
// measure the fixture app with the INSTALLED binary. If this passes, the
// published package works for a stranger running `npx next-leak`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", cwd: rootDir, ...options });

console.log("· building and packing");
run("npm", ["run", "build"]);
// Lifecycle scripts (prepare, prepack…) write to the same stdout as the JSON
// payload, so anything they print lands in front of it. Start parsing at the
// array itself instead of trusting the stream to be clean.
const packOutput = execFileSync("npm", ["pack", "--json"], { cwd: rootDir }).toString();
const jsonStart = packOutput.indexOf("[");
if (jsonStart === -1) {
  throw new Error(`npm pack --json produced no JSON payload:\n${packOutput}`);
}
const tarball = path.join(rootDir, JSON.parse(packOutput.slice(jsonStart))[0].filename);

const installDir = mkdtempSync(path.join(tmpdir(), "next-leak-pack-"));
console.log(`· installing tarball into ${installDir}`);
run("npm", ["install", "--no-save", "--no-audit", "--no-fund", tarball], { cwd: installDir });

const assert = (condition, message) => {
  if (!condition) {
    console.error(`✖ pack smoke FAILED: ${message}`);
    process.exit(1);
  }
};

const installedPackage = path.join(installDir, "node_modules", "next-leak");

// SECURITY.md promises the installed package cannot launch or download a
// browser. Check the tree a stranger actually gets, not just our own dist/.
console.log("· checking the installed tree for browser tooling");
run("node", [path.join(rootDir, "scripts", "check-bundle.mjs"), path.join(installedPackage, "dist")]);
for (const browserPackage of ["puppeteer", "puppeteer-core", "xvfb"]) {
  assert(
    !existsSync(path.join(installDir, "node_modules", browserPackage)),
    `installing the tarball pulled in ${browserPackage}`
  );
}
assert(
  existsSync(path.join(installedPackage, "THIRD-PARTY-NOTICES.md")),
  "THIRD-PARTY-NOTICES.md is missing from the published package"
);

const appDir = path.join(installDir, "demo-app");
cpSync(path.join(rootDir, "src", "__fixtures__", "e2e-app"), appDir, { recursive: true });

console.log("· measuring the fixture app with the installed binary");
const binary = path.join(installDir, "node_modules", ".bin", "next-leak");
const output = execFileSync(
  binary,
  [appDir, "--requests", "300", "--connections", "10", "--idle", "3"],
  { cwd: installDir }
).toString();
console.log(output);

assert(/✖ \/leaky\s+leak/.test(output), "installed binary did not flag the leaky route");
assert(/✔ \/\s+stable/.test(output), "installed binary did not report the healthy route stable");
assert(/growth gate \d+ KiB\/cycle/.test(output), "the report did not state the gate it used");

const stamp = readdirSync(path.join(appDir, ".next-leak"))[0];
const workDir = path.join(appDir, ".next-leak", stamp);
assert(readdirSync(workDir).includes("report.html"), "report.html missing from the bundle");
assert(
  readFileSync(path.join(workDir, "ISSUE-leaky.md"), "utf8").includes("### To Reproduce"),
  "ISSUE-leaky.md missing or incomplete"
);

// The verdict must not be a function of how much traffic the user asked for.
// It used to be: a fixed 256 KiB per-cycle gate meant the same route came out
// stable at one --requests and leaking at another, while the headline printed
// the same rate either way.
console.log("· checking the verdict does not move with --requests");
for (const requests of [600, 3000]) {
  const runOutput = execFileSync(
    binary,
    [appDir, "--requests", String(requests), "--connections", "10", "--idle", "3"],
    { cwd: installDir }
  ).toString();
  assert(
    /✖ \/leaky\s+leak/.test(runOutput),
    `/leaky came out non-leaking at ${requests} requests per cycle:\n${runOutput}`
  );
  assert(
    /✔ \/\s+stable/.test(runOutput),
    `/ came out non-stable at ${requests} requests per cycle:\n${runOutput}`
  );
}

console.log(`✔ pack smoke OK — tarball works installed (${path.basename(tarball)})`);
console.log(`  install dir kept for further validation: ${installDir}`);
