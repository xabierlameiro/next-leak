import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunReport } from "./runner.js";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const fixtureApp = fileURLToPath(new URL("./__fixtures__/e2e-app", import.meta.url));

describe("CLI interrupt safety", () => {
  it("SIGINT mid-run kills the measured app and persists a partial run.json", async () => {
    const appDir = await mkdtemp(path.join(tmpdir(), "next-leak-int-"));
    await cp(fixtureApp, appDir, { recursive: true });

    const cli = spawn(process.execPath, [path.join(rootDir, "dist", "cli.js"), appDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Let discovery finish and the first route enter its ritual, then interrupt.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    cli.kill("SIGINT");

    const exitCode: number | null = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        cli.kill("SIGKILL");
        resolve(null);
      }, 45_000);
      cli.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).toBe(130);

    const runsDir = path.join(appDir, ".next-leak");
    const [stamp] = await readdir(runsDir);
    expect(stamp).toBeDefined();
    const run = JSON.parse(
      await readFile(path.join(runsDir, stamp ?? "", "run.json"), "utf8")
    ) as RunReport;
    // The route in flight failed or finished; everything after it is marked.
    const interrupted = run.routes.filter(
      (route) => route.status === "skipped" && route.reason === "interrupted"
    );
    expect(run.routes).toHaveLength(2);
    expect(interrupted.length).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
