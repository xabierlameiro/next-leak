import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const rootDir = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(rootDir, "dist", "cli.js");

type CliOutcome = { code: number; stdout: string; stderr: string };

async function invoke(args: string[]): Promise<CliOutcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const failure = cause as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * pack-smoke exercises the happy path against a real app. What it never
 * touches are the exits a user hits first: bad flags, bad targets, bare
 * invocation. Each of these is a sentence someone reads and an exit code
 * something scripts against — both are contract.
 */
describe("cli surface", () => {
  it("prints the version and exits 0", async () => {
    const outcome = await invoke(["--version"]);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("bare invocation shows help but exits non-zero", async () => {
    // Help-as-error: running with no target is a mistake, and scripts must
    // see it as one, but the human should still get the usage text.
    const outcome = await invoke([]);
    expect(outcome.code).toBe(1);
    expect(outcome.stdout).toContain("Usage:");
  });

  it("explicit --help exits 0", async () => {
    const outcome = await invoke(["--help"]);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("--max-old-space");
    expect(outcome.stdout).toContain("--no-resolve");
  });

  it("rejects an unknown flag with its name and exits 1", async () => {
    const outcome = await invoke(["some-app", "--cylces", "6"]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('unknown option "--cylces"');
  });

  it("fails a nonexistent target with an actionable message, not a stack", async () => {
    const outcome = await invoke(["/nonexistent-next-app"]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("error:");
    expect(outcome.stderr).not.toContain("at async");
  });
});
