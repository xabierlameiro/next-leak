#!/usr/bin/env node
// Release gate: pack the real tarball, install it in a clean directory, and
// measure the fixture app with the INSTALLED binary. If this passes, the
// published package works for a stranger running `npx next-leak`.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
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

const assert = (condition, message) => {
  if (!condition) {
    console.error(`✖ pack smoke FAILED: ${message}`);
    process.exit(1);
  }
};
assert(/✖ \/leaky\s+leak/.test(output), "installed binary did not flag the leaky route");
assert(/✔ \/\s+stable/.test(output), "installed binary did not report the healthy route stable");

const stamp = readdirSync(path.join(appDir, ".next-leak"))[0];
const workDir = path.join(appDir, ".next-leak", stamp);
assert(readdirSync(workDir).includes("report.html"), "report.html missing from the bundle");
assert(
  readFileSync(path.join(workDir, "ISSUE-leaky.md"), "utf8").includes("### To Reproduce"),
  "ISSUE-leaky.md missing or incomplete"
);

console.log(`✔ pack smoke OK — tarball works installed (${path.basename(tarball)})`);
console.log(`  install dir kept for further validation: ${installDir}`);
