import { describe, expect, it } from "vitest";
import type { RitualOptions, RitualResult } from "./ritual.js";
import { runSelfCheck } from "./self-check.js";

const MB = 1024 * 1024;

function ritualResult(
  options: RitualOptions,
  verdict: "leak" | "stable",
  growthPerCycle: number
): RitualResult {
  return {
    route: options.route,
    timings: [],
    loadOutcomes: [],
    settleOutcomes: [],
    peaks: [],
    samples: [],
    memorySamples: [],
    unreclaimedSamples: [],
    unreclaimedTrend: { verdict: "inconclusive", growthPerCycle: 0, deltas: [] },
    baselineSnapshot: "/tmp/baseline.heapsnapshot",
    afterSnapshot: "/tmp/after.heapsnapshot",
    trend: { verdict, growthPerCycle, deltas: [] },
    requestsPerCycle: 5000,
    minGrowthPerCycle: 256 * 1024,
  };
}

describe("runSelfCheck", () => {
  it("passes when the harness detects the leak it planted", async () => {
    const result = await runSelfCheck(
      { bootstrapPath: "/fake/bootstrap.js", appPort: 65_001 },
      { ritual: async (options) => ritualResult(options, "leak", 12 * MB) },
    );

    expect(result.passed).toBe(true);
    expect(result.verdict).toBe("leak");
    // 12 MB per cycle over 5000 requests is 2.4 MB per 1000.
    expect(result.growthPer1000Requests).toBeCloseTo(2.4 * MB, -4);
    expect(result.summary).toContain("harness verified");
  });

  it("fails loudly when a planted leak comes back stable", async () => {
    // Not a statement about the route: it says the instrument is not working,
    // and a flat curve from it means nothing at all.
    const result = await runSelfCheck(
      { bootstrapPath: "/fake/bootstrap.js", appPort: 65_001 },
      { ritual: async (options) => ritualResult(options, "stable", 1024) },
    );

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("cannot be trusted");
    expect(result.summary).toContain("not that nothing leaks");
  });

  it("measures a server it wrote itself, at the caller's regime", async () => {
    let seen: RitualOptions | undefined;
    await runSelfCheck(
      {
        bootstrapPath: "/fake/bootstrap.js",
        appPort: 65_002,
        loadRequests: 300,
        connections: 8,
        maxOldSpaceMb: 1024,
      },
      {
        ritual: async (options) => {
          seen = options;
          return ritualResult(options, "leak", 5 * MB);
        },
      },
    );

    expect(seen?.route).toBe("/");
    expect(seen?.serverPath).toMatch(/next-leak-self-check-.*server\.js$/);
    expect(seen?.loadRequests).toBe(300);
    expect(seen?.connections).toBe(8);
    expect(seen?.maxOldSpaceMb).toBe(1024);
  });

  it("cleans up the planted server even when the ritual throws", async () => {
    const { access } = await import("node:fs/promises");
    let serverPath = "";
    await expect(
      runSelfCheck(
        { bootstrapPath: "/fake/bootstrap.js", appPort: 65_003 },
        {
          ritual: async (options) => {
            serverPath = options.serverPath;
            throw new Error("ritual exploded");
          },
        },
      ),
    ).rejects.toThrow("ritual exploded");

    await expect(access(serverPath)).rejects.toThrow();
  });
});

// The template is what the check actually measures. If it stops retaining,
// every self-check passes silently and vouches for nothing.
describe("the planted server", () => {
  it("retains across requests and reports the count", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { spawn } = await import("node:child_process");
    const path = await import("node:path");
    const { SELF_CHECK_SERVER } = await import("./self-check.js");
    const { freePort } = await import("./runner.js");

    const dir = await mkdtemp(path.join(tmpdir(), "next-leak-planted-"));
    const file = path.join(dir, "server.mjs");
    await writeFile(file, SELF_CHECK_SERVER);
    const port = await freePort();
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1" },
      stdio: "ignore",
    });

    try {
      const counts: number[] = [];
      for (let attempt = 0; attempt < 40 && counts.length === 0; attempt += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`);
          counts.push(((await response.json()) as { retained: number }).retained);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      for (let i = 0; i < 2; i += 1) {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        counts.push(((await response.json()) as { retained: number }).retained);
      }

      // Each request adds one 8 KB string that is never released.
      expect(counts).toEqual([1, 2, 3]);
    } finally {
      child.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
