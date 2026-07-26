import { execFile } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const rootDir = fileURLToPath(new URL("..", import.meta.url));
const bootstrap = `file://${path.join(rootDir, "dist", "bootstrap.js")}`;

/**
 * The bootstrap rides inside the *user's* server process, and its contract
 * has a hard clause: it must never break the host app — not when disabled,
 * not when it fails. The lifecycle tests cover the happy path; these are the
 * failure branches.
 */
describe("bootstrap failure branches", () => {
  it("is inert without NEXT_LEAK_DIR: no files, no noise, host unharmed", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "next-leak-inert-"));
    const environment = { ...process.env };
    delete environment["NEXT_LEAK_DIR"];

    const { stderr } = await run(
      process.execPath,
      ["--import", bootstrap, "-e", "0"],
      { env: environment, timeout: 20_000 }
    );

    expect((await readdir(workDir)).filter((name) => name.startsWith("control-"))).toEqual([]);
    expect(stderr).not.toContain("next-leak");
  }, 30_000);

  it("logs the failure and lets the host run when the work dir cannot exist", async () => {
    // A path under a file: mkdir fails on every platform. The host app must
    // still exit 0 — a diagnostics tool that can crash the app it diagnoses
    // is worse than no tool.
    const { stderr } = await run(
      process.execPath,
      ["--import", bootstrap, "-e", "console.log('host survived')"],
      {
        env: { ...process.env, NEXT_LEAK_DIR: path.join("/dev/null", "next-leak") },
        timeout: 20_000,
      }
    );
    expect(stderr).toContain("[next-leak] control channel failed to start");
  }, 30_000);
});
