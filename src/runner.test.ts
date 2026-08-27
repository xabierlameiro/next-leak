import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RitualResult } from "./ritual.js";
import {
  estimateRun,
  formatDuration,
  formatEstimate,
  routeSlug,
  runMeasurement,
  type RunnerDeps,
} from "./runner.js";

const MB = 1024 * 1024;
const FIXTURES = new URL("./__fixtures__/", import.meta.url);

async function makeAppDir(appPaths: Record<string, string>): Promise<string> {
  const appDir = await mkdtemp(path.join(tmpdir(), "next-leak-runner-"));
  await mkdir(path.join(appDir, ".next", "standalone"), { recursive: true });
  await mkdir(path.join(appDir, ".next", "server"), { recursive: true });
  await writeFile(path.join(appDir, ".next", "standalone", "server.js"), "// stub\n");
  await writeFile(
    path.join(appDir, ".next", "server", "app-paths-manifest.json"),
    JSON.stringify(appPaths)
  );
  await cp(
    new URL("routes-manifest.json", FIXTURES),
    path.join(appDir, ".next", "routes-manifest.json")
  );
  return appDir;
}

function ritualResult(route: string, samples: number[]): RitualResult {
  return {
    route,
    timings: [{ phase: "warm-up", seconds: 1 }],
    loadOutcomes: [{ phase: "cycle 1", sent: 5000, ok2xx: 5000 }],
    settleOutcomes: [{ phase: "cycle 1", status: "settled" as const, polls: 2 }],
    peaks: [
      {
        phase: "cycle 1",
        heapUsed: 60 * 1024 * 1024,
        external: 1024 * 1024,
        arrayBuffers: 1024 * 1024,
        rss: 180 * 1024 * 1024,
        polls: 40,
      },
    ],
    samples,
    memorySamples: samples.map((heapUsed) => ({
      gcExposed: true,
      heapUsed,
      rss: 3 * heapUsed,
      external: 0,
      arrayBuffers: 0,
    })),
    unreclaimedSamples: [],
    unreclaimedTrend: { verdict: "inconclusive" as const, growthPerCycle: 0, deltas: [] },
    baselineSnapshot: `/snap/${route}/baseline.heapsnapshot`,
    afterSnapshot: `/snap/${route}/after.heapsnapshot`,
    trend: {
      verdict: route === "/leaky" ? "leak" : "stable",
      growthPerCycle: route === "/leaky" ? 2.5 * MB : 0.1 * MB,
      deltas: [],
    },
    requestsPerCycle: 5000,
    minGrowthPerCycle: 256 * 1024,
  };
}

function makeDeps(events: string[]): RunnerDeps {
  return {
    ritual: async (options) => {
      events.push(`ritual:${options.route}`);
      if (options.route === "/broken") {
        throw new Error("route exploded under load");
      }
      return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
    },
    diff: async (baseline) => {
      events.push(`diff:${baseline}`);
      return {
        typeDeltas: [],
        grownNodes: [
          {
            kind: "grown" as const,
            nodeType: "object",
            name: "Array",
            retainedBytes: 5 * MB,
            retainerChain: "x <- y",
            moduleIds: [35194],
          },
        ],
        newNodes: [],
      };
    },
    freePort: async () => 65_001,
    registry: async () => new Map([[35194, "[project]/src/app/leaky/page.tsx"]]),
    nextVersion: async () => "16.0.1",
  };
}

// Killed mutants — each one a behaviour the suite previously accepted broken.
describe("mutation-hardening: runner", () => {
  it("hands every option through to the ritual, and omits what was not given", async () => {
    // The silent-passthrough class: an option dropped between runMeasurement
    // and the ritual measures a different experiment than the one requested.
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    await writeFile(
      path.join(appDir, "next-leak.config.json"),
      JSON.stringify({
        headers: { "accept-encoding": "gzip" },
        abandonAfterMs: 7,
      })
    );
    const received: unknown[] = [];
    await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        warmupRequests: 111,
        loadRequests: 2222,
        connections: 33,
        cycles: 5,
        idleMs: 4444,
        maxOldSpaceMb: 1024,
      },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          received.push(options);
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );

    const ritualOptions = received[0] as Record<string, unknown>;
    expect(ritualOptions["warmupRequests"]).toBe(111);
    expect(ritualOptions["loadRequests"]).toBe(2222);
    expect(ritualOptions["connections"]).toBe(33);
    expect(ritualOptions["cycles"]).toBe(5);
    expect(ritualOptions["idleMs"]).toBe(4444);
    expect(ritualOptions["maxOldSpaceMb"]).toBe(1024);
    expect(ritualOptions["headers"]).toEqual({ "accept-encoding": "gzip" });
    expect(ritualOptions["abandonAfterMs"]).toBe(7);

    // The work directory is per-route, ordinal-prefixed, and slugged.
    expect(String(ritualOptions["workDir"])).toMatch(/01-root$/);
  });

  it("passes nothing the caller did not set, so ritual defaults stay in charge", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const received: unknown[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          received.push(options);
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );
    const ritualOptions = received[0] as Record<string, unknown>;
    for (const knob of ["warmupRequests", "loadRequests", "connections", "cycles", "idleMs", "maxOldSpaceMb", "headers", "abandonAfterMs"]) {
      expect(knob in ritualOptions, knob).toBe(false);
    }
  });

  it("records the regime in parameters even when defaults fill it", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", connections: 12, maxOldSpaceMb: 2048 },
      makeDeps([])
    );
    // `?? default` degraded to `&& default` overwrites explicit values.
    expect(report.parameters.connections).toBe(12);
    expect(report.parameters.maxOldSpaceMb).toBe(2048);
  });

  it("computes the RSS rate from the same window as the heap verdict", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const rss = [100 * MB, 200 * MB, 210 * MB, 226 * MB];
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      {
        ...makeDeps([]),
        ritual: async (options) => ({
          ...ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]),
          memorySamples: rss.map((value) => ({
            gcExposed: true,
            heapUsed: 30 * MB,
            rss: value,
            external: 0,
            arrayBuffers: 0,
          })),
        }),
      }
    );
    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("route should be measured");
    // Warm-up delta (100→200) excluded; mean of (+10, +16) = 13 MB per cycle
    // over 5000 requests/cycle → 2.6 MB per 1000 requests.
    expect(route.rssPer1000Requests).toBeCloseTo(2.6 * MB, -4);
  });

  it("does not diff stable routes unless asked, and announces the diff when it runs", async () => {
    const appDir = await makeAppDir({ "/stable/page": "app/stable/page.js" });
    const events: string[] = [];
    const progressLines: string[] = [];
    await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        onProgress: (message) => progressLines.push(message),
      },
      {
        ...makeDeps(events),
        ritual: async (options) => ({
          ...ritualResult(options.route, [29 * MB, 30 * MB, 30 * MB, 30 * MB]),
          trend: { verdict: "stable" as const, growthPerCycle: 0, deltas: [0, 0], source: "heap" as const },
        }),
      }
    );
    expect(events.filter((event) => event.startsWith("diff:"))).toEqual([]);
    expect(progressLines.some((line) => line.startsWith("diffing snapshots"))).toBe(false);
  });

  it("narrates each route with its ordinal and the concrete path measured", async () => {
    const appDir = await makeAppDir({ "/products/[id]/page": "app/products/[id]/page.js" });
    await writeFile(
      path.join(appDir, "next-leak.config.json"),
      JSON.stringify({ params: { id: "42" } })
    );
    const progressLines: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (m) => progressLines.push(m) },
      makeDeps([])
    );
    expect(progressLines.some((line) => line.includes("measuring /products/[id] (1/1) as /products/42"))).toBe(true);
  });

  it("announces the withdrawal when the audit overrides a verdict", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const progressLines: string[] = [];
    await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        resolveInconclusive: false,
        onProgress: (m) => progressLines.push(m),
      },
      {
        ...makeDeps([]),
        ritual: async (options) => ({
          ...ritualResult(options.route, [29 * MB, 30 * MB, 31 * MB, 32 * MB]),
          // A leak on thin evidence: three deltas below 4x the gate → the
          // audit withdraws it. (1 MB would sit exactly ON the 4x boundary
          // of the 256 KiB gate and survive — found writing this test.)
          trend: {
            verdict: "leak" as const,
            growthPerCycle: 0.5 * MB,
            deltas: [0.5 * MB, 0.5 * MB, 0.5 * MB],
            source: "heap" as const,
          },
        }),
      }
    );
    expect(progressLines.some((line) => line.includes("withdrawing / verdict"))).toBe(true);
  });

  it("keeps the run directory filesystem-safe and under the app by default", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      makeDeps([])
    );
    // Colons in ISO timestamps are invalid on some filesystems; the default
    // output home is the app's own .next-leak.
    expect(path.basename(report.workDir)).not.toMatch(/[:.]/);
    expect(report.workDir).toContain(path.join(appDir, ".next-leak"));
  });

  it("reads the module registry from the server build", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const registryPaths: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      {
        ...makeDeps([]),
        registry: async (dir: string) => {
          registryPaths.push(dir);
          return new Map();
        },
      }
    );
    expect(registryPaths[0]).toBe(path.join(appDir, ".next", "server"));
  });

  it("orders routes deterministically", async () => {
    const appDir = await makeAppDir({
      "/zebra/page": "app/zebra/page.js",
      "/alpha/page": "app/alpha/page.js",
      "/middle/page": "app/middle/page.js",
    });
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      makeDeps([])
    );
    expect(report.routes.map((route) => route.route)).toEqual(["/alpha", "/middle", "/zebra"]);
  });
});

describe("mutation-hardening: runner, second pass", () => {
  const stableRitual = (route: string): RitualResult => ({
    ...ritualResult(route, [29 * MB, 30 * MB, 30 * MB, 30 * MB]),
    trend: { verdict: "stable" as const, growthPerCycle: 0, deltas: [0, 0], source: "heap" as const },
  });

  it("diffs stable routes when --diff-all asks for it", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const events: string[] = [];
    const progressLines: string[] = [];
    const report = await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        diffAll: true,
        onProgress: (m) => progressLines.push(m),
      },
      { ...makeDeps(events), ritual: async (options) => stableRitual(options.route) }
    );
    expect(events.some((event) => event.startsWith("diff:"))).toBe(true);
    expect(progressLines.some((line) => line === "diffing snapshots for /")).toBe(true);
    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("route should be measured");
    // With a diff and a registry present, attribution must be computed too.
    expect(route.attribution).not.toBeNull();
  });

  it("flags an abandon run that abandoned nothing — the audit saw the config", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    await writeFile(
      path.join(appDir, "next-leak.config.json"),
      JSON.stringify({ abandonAfterMs: 7 })
    );
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", resolveInconclusive: false },
      makeDeps([])
    );
    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("route should be measured");
    // ritualResult's outcomes carry no abandonments, so the audit must warn —
    // unless abandonAfterMs was dropped on its way in.
    expect(route.confidence.warnings.map((warning) => warning.code)).toContain("abandon-ineffective");
  });

  it("leaves attribution null when the registry is empty", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      { ...makeDeps([]), registry: async () => new Map() }
    );
    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("route should be measured");
    // An empty registry cannot attribute anything; fabricating an attribution
    // from it would put "unattributed" rows where the report expects silence.
    expect(route.attribution).toBeNull();
  });

  it("omits the Next version from the narration when none was found", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const progressLines: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (m) => progressLines.push(m) },
      { ...makeDeps([]), nextVersion: async () => null }
    );
    const line = progressLines.find((entry) => entry.includes("module registry"));
    expect(line).toBe("module registry: 1 modules");
  });

  it("suppresses the long-run hint once either load knob is hand-set", async () => {
    const manyRoutes = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`/route${index}/page`, `app/route${index}/page.js`])
    );
    const appDir = await makeAppDir(manyRoutes);
    const onlyRequests: string[] = [];
    await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        loadRequests: 300,
        onProgress: (m) => onlyRequests.push(m),
      },
      makeDeps([])
    );
    expect(onlyRequests.find((line) => line.includes("estimated"))).not.toContain("--routes");

    const onlyIdle: string[] = [];
    await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        idleMs: 2000,
        onProgress: (m) => onlyIdle.push(m),
      },
      makeDeps([])
    );
    expect(onlyIdle.find((line) => line.includes("estimated"))).not.toContain("--routes");
  });

  it("writes the second pass into its own -resolve directory", async () => {
    // Reusing the first pass's directory would overwrite its snapshots:
    // baseline.heapsnapshot and after.heapsnapshot are named per phase, not
    // per pass, and evidence that gets clobbered cannot be audited.
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const workDirs: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", routeFilter: ["/"] },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          workDirs.push(options.workDir);
          if (workDirs.length === 1) {
            return {
              ...ritualResult(options.route, [30 * MB, 31 * MB, 31 * MB, 32 * MB]),
              trend: {
                verdict: "inconclusive" as const,
                growthPerCycle: 0.4 * MB,
                deltas: [0, 0.4 * MB],
                source: "heap" as const,
              },
            };
          }
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );
    expect(workDirs).toHaveLength(2);
    expect(workDirs[1]).toBe(`${workDirs[0]}-resolve`);
  });

  it("narrates the second pass and its failure with the route named", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const progressLines: string[] = [];
    let calls = 0;
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (m) => progressLines.push(m) },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          calls += 1;
          if (calls === 2) {
            throw new Error("port race lost twice");
          }
          return {
            ...ritualResult(options.route, [30 * MB, 31 * MB, 31 * MB, 32 * MB]),
            trend: {
              verdict: "inconclusive" as const,
              growthPerCycle: 0.4 * MB,
              deltas: [0, 0.4 * MB],
              source: "heap" as const,
            },
          };
        },
      }
    );
    expect(progressLines.some((line) => line.includes("re-measuring / with 8 cycles"))).toBe(true);
    expect(
      progressLines.some((line) => line.includes("re-measurement of / failed") && line.includes("keeping the first pass"))
    ).toBe(true);
  });

  it("announces the second pass in the estimate, unless opted out", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const withNote: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (m) => withNote.push(m) },
      makeDeps([])
    );
    expect(
      withNote.some((line) =>
        line.includes("undecided and still-decelerating routes are measured again")
      )
    ).toBe(true);

    const without: string[] = [];
    await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        resolveInconclusive: false,
        onProgress: (m) => without.push(m),
      },
      makeDeps([])
    );
    expect(without.some((line) => line.includes("measured again"))).toBe(false);
  });

  it("warns about long default runs, and stays quiet once load is hand-tuned", async () => {
    const manyRoutes = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`/route${index}/page`, `app/route${index}/page.js`])
    );
    const appDir = await makeAppDir(manyRoutes);
    const slow: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (m) => slow.push(m) },
      makeDeps([])
    );
    const estimateLine = slow.find((line) => line.includes("estimated")) ?? "";
    expect(estimateLine).toContain("--routes");

    const tuned: string[] = [];
    await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        loadRequests: 300,
        idleMs: 2000,
        onProgress: (m) => tuned.push(m),
      },
      makeDeps([])
    );
    const tunedLine = tuned.find((line) => line.includes("estimated")) ?? "";
    expect(tunedLine).not.toContain("--routes");
  });

  it("narrates the registry size and the Next version it found", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const progressLines: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (m) => progressLines.push(m) },
      makeDeps([])
    );
    expect(progressLines.some((line) => line.includes("module registry: 1 modules · next 16.0.1"))).toBe(true);
  });

  it("names the missing sample params when skipping a dynamic route", async () => {
    const appDir = await makeAppDir({ "/products/[id]/page": "app/products/[id]/page.js" });
    const progressLines: string[] = [];
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (m) => progressLines.push(m) },
      makeDeps([])
    );
    const skipped = report.routes.find((route) => route.status === "skipped");
    expect(skipped?.status === "skipped" && skipped.reason).toContain("sample params");
    expect(
      progressLines.some((line) => line.includes("skipping /products/[id] (1/1)") && line.includes("sample params"))
    ).toBe(true);
  });

  it("measures a static route with a bare label — no phantom 'as' suffix", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const progressLines: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (m) => progressLines.push(m) },
      makeDeps([])
    );
    expect(progressLines).toContain("measuring / (1/1)");
    // And a clean run never claims to withdraw anything.
    expect(progressLines.some((line) => line.includes("withdrawing"))).toBe(false);
  });

  it("computes an RSS rate from exactly three samples and refuses fewer", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const withSamples = async (rss: number[]): Promise<number> => {
      const report = await runMeasurement(
        { appDir, bootstrapPath: "/fake/bootstrap.js" },
        {
          ...makeDeps([]),
          ritual: async (options) => ({
            ...ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]),
            memorySamples: rss.map((value) => ({
              gcExposed: true,
              heapUsed: 30 * MB,
              rss: value,
              external: 0,
              arrayBuffers: 0,
            })),
          }),
        }
      );
      const route = report.routes[0];
      if (route?.status !== "measured") throw new Error("route should be measured");
      return route.rssPer1000Requests;
    };
    // Three samples leave one post-warm-up delta: (+20 MB) / 5000 req → 4 MB/1000.
    expect(await withSamples([100 * MB, 200 * MB, 220 * MB])).toBeCloseTo(4 * MB, -4);
    // Two samples cannot exclude warm-up and still have a delta: rate is 0.
    expect(await withSamples([100 * MB, 200 * MB])).toBe(0);
  });

  it("matches selectors exactly and ignores their trailing slashes", async () => {
    const appDir = await makeAppDir({
      "/api/page": "app/api/page.js",
      "/api/users/page": "app/api/users/page.js",
    });
    const exact = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", routeFilter: ["/api"] },
      makeDeps([])
    );
    expect(exact.routes.map((route) => route.route).sort()).toEqual(["/api", "/api/users"]);

    const trailing = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", routeFilter: ["/api/"] },
      makeDeps([])
    );
    expect(trailing.routes.map((route) => route.route)).toContain("/api");
  });

  it("stamps the run directory with the full sortable timestamp", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      makeDeps([])
    );
    expect(path.basename(report.workDir)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });

  it("judges the heap ceiling against the cap the run actually used", async () => {
    // 400 MB retained under a 4096 MB cap is nowhere near the ceiling; a
    // mutant that swaps the cap for the 512 MB default would warn here.
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", maxOldSpaceMb: 4096 },
      {
        ...makeDeps([]),
        ritual: async (options) => ({
          ...ritualResult(options.route, [390 * MB, 395 * MB, 400 * MB, 400 * MB]),
          memorySamples: [390, 395, 400, 400].map((mb) => ({
            gcExposed: true,
            heapUsed: mb * MB,
            rss: 500 * MB,
            external: 0,
            arrayBuffers: 0,
          })),
        }),
      }
    );
    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("route should be measured");
    expect(route.confidence.warnings.map((warning) => warning.code)).not.toContain("near-heap-ceiling");
  });
});

describe("routeSlug", () => {
  it("keeps a reversible slug bare and gives lossy ones a 6-hex digest", () => {
    // "/a/b" is made of safe characters, so its slug is reversible and stays
    // bare; "/a_b" sanitizes to the same "a_b", and the digest is what keeps
    // the two from colliding on one ISSUE-a_b.md.
    expect(routeSlug("/a/b")).toBe("a_b");
    expect(routeSlug("/a_b")).toMatch(/^a_b-[0-9a-f]{6}$/);
    expect(routeSlug("/a/b")).not.toBe(routeSlug("/a_b"));
  });

  it("falls back to route-<digest> when nothing sanitizable remains", () => {
    expect(routeSlug("/ñ")).toMatch(/^route-[0-9a-f]{6}$/);
  });
});

describe("formatDuration boundaries", () => {
  it("switches to hours exactly at 90 minutes", () => {
    expect(formatDuration(5399)).toBe("90m");
    expect(formatDuration(5400)).toBe("1.5h");
  });
});

describe("estimateRun", () => {
  const parameters = {
    warmupRequests: 200,
    loadRequests: 5000,
    connections: 100,
    cycles: 4,
    idleMs: 30_000,
    maxOldSpaceMb: 512,
    minGrowthPerCycle: 256 * 1024,
  };

  it("puts a 60-route default run in the hours range (the first-user wall)", () => {
    const { slowSeconds } = estimateRun(60, parameters);
    expect(slowSeconds).toBeGreaterThan(2 * 3600);
    expect(formatDuration(slowSeconds)).toMatch(/h$/);
  });

  it("keeps small scoped runs in minutes", () => {
    const { slowSeconds } = estimateRun(3, { ...parameters, loadRequests: 300, idleMs: 5000 });
    expect(slowSeconds).toBeLessThan(15 * 60);
    expect(formatDuration(90)).toBe("2m");
    expect(formatDuration(45)).toBe("45s");
  });

  // The 2026-07-22 gate: a virgin create-next-app was announced at "≈ 5m" and
  // finished in 42s. The floor bills the adaptive settle (2 polls per cycle),
  // not the full idle window, so it lands beside the real run.
  it("floors a two-route default run at its fixed costs, not the idle window", () => {
    const estimate = estimateRun(2, parameters);
    expect(estimate.fastSeconds).toBe(2 * (10 + 4 * 4));
    expect(formatEstimate(estimate)).toBe("≈ 52s–7m");
  });

  it("never floors above the idle window the user asked for", () => {
    const estimate = estimateRun(2, { ...parameters, idleMs: 300 });
    expect(estimate.fastSeconds).toBe(22);
    expect(estimate.fastSeconds).toBeLessThanOrEqual(estimate.slowSeconds);
  });

  it("prints a single value when both bounds round alike", () => {
    expect(formatEstimate({ fastSeconds: 44, slowSeconds: 44 })).toBe("≈ 44s");
  });
});

// `inconclusive` is the verdict that asks the user to run the tool again. On
// the vercel/next.js#95094 repro at --quick it lands on a real leak: three
// deltas cannot carry it, six can. The run goes back for the evidence itself.
describe("resolving inconclusive routes", () => {
  const inconclusive = (route: string): RitualResult => ({
    ...ritualResult(route, [30 * MB, 31 * MB, 31 * MB, 32 * MB]),
    trend: { verdict: "inconclusive", growthPerCycle: 0.4 * MB, deltas: [0, 0.4 * MB], source: "heap" },
  });
  const leaking = (route: string): RitualResult => ({
    ...ritualResult(route, [30 * MB, 40 * MB, 50 * MB, 60 * MB, 70 * MB, 80 * MB, 90 * MB]),
    trend: {
      verdict: "leak",
      growthPerCycle: 10 * MB,
      deltas: Array.from({ length: 5 }, () => 10 * MB),
      source: "heap",
    },
  });

  it("measures again with more cycles and reports the resolved verdict", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const calls: Array<number | undefined> = [];
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", routeFilter: ["/"] },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          calls.push(options.cycles);
          return calls.length === 1 ? inconclusive(options.route) : leaking(options.route);
        },
      }
    );

    const route = report.routes.find((entry) => entry.route === "/");
    if (route?.status !== "measured") throw new Error("route should be measured");
    expect(route.trend.verdict).toBe("leak");
    expect(route.resolvedWithCycles).toBe(8);
    // Default is 4 cycles; the second pass uses the figure the report tells a
    // user to pass by hand.
    expect(calls).toEqual([undefined, 8]);
  });

  it("leaves decided routes alone", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    let calls = 0;
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", routeFilter: ["/"] },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          calls += 1;
          return leaking(options.route);
        },
      }
    );
    expect(calls).toBe(1);
  });

  it("does not go back when the user said not to", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    let calls = 0;
    const report = await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        routeFilter: ["/"],
        resolveInconclusive: false,
      },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          calls += 1;
          return inconclusive(options.route);
        },
      }
    );
    expect(calls).toBe(1);
    const route = report.routes.find((entry) => entry.route === "/");
    if (route?.status !== "measured") throw new Error("route should be measured");
    expect(route.resolvedWithCycles).toBeUndefined();
  });

  it("keeps the first pass when the second one dies", async () => {
    // The second pass is a bonus, not a bet: a child that loses the port race
    // twice or dies under the longer run must not turn a valid inconclusive
    // measurement into a "failed" route.
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    let calls = 0;
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", routeFilter: ["/"] },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          calls += 1;
          if (calls === 2) {
            throw new Error("the measured process ran out of heap");
          }
          return inconclusive(options.route);
        },
      }
    );
    expect(calls).toBe(2);
    const route = report.routes.find((entry) => entry.route === "/");
    if (route?.status !== "measured") throw new Error("first pass should survive");
    expect(route.trend.verdict).toBe("inconclusive");
    expect(route.resolvedWithCycles).toBeUndefined();
  });

  it("does not start a second pass after the user interrupted", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const aborter = new AbortController();
    let calls = 0;
    await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        routeFilter: ["/"],
        signal: aborter.signal,
      },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          calls += 1;
          // The interrupt lands while the first pass is finishing.
          aborter.abort();
          return inconclusive(options.route);
        },
      }
    );
    expect(calls).toBe(1);
  });

  it("reports the second pass when it is still undecided", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", routeFilter: ["/"] },
      { ...makeDeps([]), ritual: async (options) => inconclusive(options.route) }
    );
    const route = report.routes.find((entry) => entry.route === "/");
    if (route?.status !== "measured") throw new Error("route should be measured");
    expect(route.trend.verdict).toBe("inconclusive");
    expect(route.resolvedWithCycles).toBe(8);
  });
});

describe("runMeasurement", () => {
  it("measures static routes, skips dynamic ones, and survives failing routes", async () => {
    const appDir = await makeAppDir({
      "/page": "app/page.js",
      "/leaky/page": "app/leaky/page.js",
      "/broken/page": "app/broken/page.js",
      "/products/[id]/page": "app/products/[id]/page.js",
    });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-out-"));
    const events: string[] = [];

    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir },
      makeDeps(events)
    );

    const byRoute = new Map(report.routes.map((route) => [route.route, route]));
    expect(byRoute.get("/products/[id]")?.status).toBe("skipped");
    expect(byRoute.get("/broken")).toMatchObject({
      status: "failed",
      reason: "route exploded under load",
    });
    expect(byRoute.get("/")?.status).toBe("measured");
    expect(byRoute.get("/leaky")?.status).toBe("measured");
    // The failing route did not abort the rest of the run.
    expect(events.filter((event) => event.startsWith("ritual:"))).toHaveLength(3);
  });

  it("measures dynamic routes when next-leak.config.json provides sample params", async () => {
    const appDir = await makeAppDir({
      "/[lang]/dashboard/page": "app/[lang]/dashboard/page.js",
      "/[lang]/share/[shareId]/page": "app/[lang]/share/[shareId]/page.js",
    });
    await writeFile(
      path.join(appDir, "next-leak.config.json"),
      JSON.stringify({ params: { lang: "en" } })
    );
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-out-"));
    const events: string[] = [];

    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir },
      makeDeps(events)
    );

    const dashboard = report.routes.find((route) => route.route === "/[lang]/dashboard");
    if (dashboard?.status !== "measured") {
      throw new Error("expected /[lang]/dashboard to be measured");
    }
    expect(dashboard.requestPath).toBe("/en/dashboard");
    expect(events).toContain("ritual:/en/dashboard");
    // shareId has no sample value anywhere → still skipped.
    expect(
      report.routes.find((route) => route.route === "/[lang]/share/[shareId]")?.status
    ).toBe("skipped");
  });

  it("diffs only non-stable verdicts by default and computes growth per 1000 requests", async () => {
    const appDir = await makeAppDir({
      "/page": "app/page.js",
      "/leaky/page": "app/leaky/page.js",
    });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-out-"));
    const events: string[] = [];

    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir },
      makeDeps(events)
    );

    expect(events.filter((event) => event.startsWith("diff:"))).toEqual([
      "diff:/snap//leaky/baseline.heapsnapshot",
    ]);
    const leaky = report.routes.find((route) => route.route === "/leaky");
    if (leaky?.status !== "measured") {
      throw new Error("expected /leaky to be measured");
    }
    expect(leaky.growthPer1000Requests).toBe(0.5 * MB);
    expect(leaky.diff).not.toBeNull();
    // Attribution wired through the injected registry.
    expect(leaky.attribution?.route).toMatchObject({
      owner: "app",
      source: "src/app/leaky/page.tsx",
    });
    expect(leaky.signatures).toEqual([]);
    const healthy = report.routes.find((route) => route.route === "/");
    if (healthy?.status !== "measured") {
      throw new Error("expected / to be measured");
    }
    expect(healthy.diff).toBeNull();
    expect(healthy.attribution).toBeNull();
  });

  it("persists run.json with the full machine-readable report", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-out-"));

    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir },
      makeDeps([])
    );

    const persisted = JSON.parse(
      await readFile(path.join(report.workDir, "run.json"), "utf8")
    ) as typeof report;
    expect(persisted).toEqual(report);
    expect(persisted.workDir.startsWith(outputDir)).toBe(true);
  });

  it("filters routes with routeFilter, warning about unmatched selectors", async () => {
    const appDir = await makeAppDir({
      "/page": "app/page.js",
      "/leaky/page": "app/leaky/page.js",
      "/api/health/route": "app/api/health/route.js",
    });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-out-"));
    const events: string[] = [];
    const progress: string[] = [];

    const report = await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        outputDir,
        routeFilter: ["/api", "/nope"],
        onProgress: (message) => progress.push(message),
      },
      makeDeps(events)
    );

    expect(report.routes.map((route) => route.route)).toEqual(["/api/health"]);
    expect(progress.some((message) => message.includes('"/nope" matched no'))).toBe(true);
  });

  it('treats "/" as exact and prefixes as segment-aware (no /apiary for /api)', async () => {
    const appDir = await makeAppDir({
      "/page": "app/page.js",
      "/apiary/page": "app/apiary/page.js",
      "/api/health/route": "app/api/health/route.js",
    });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-out-"));

    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir, routeFilter: ["/", "/api"] },
      makeDeps([])
    );

    expect(report.routes.map((route) => route.route)).toEqual(["/", "/api/health"]);
  });

  it("records the gate that matches the traffic it was told to send", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-out-"));

    const report = await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        outputDir,
        loadRequests: 20_000,
        maxOldSpaceMb: 2048,
      },
      makeDeps([])
    );

    // 4x the default traffic per cycle, so 4x the growth a cycle must show to
    // mean the same thing. Before this, the gate stayed at 256 KiB and the
    // verdict quietly got four times more sensitive.
    expect(report.parameters.minGrowthPerCycle).toBe(4 * 256 * 1024);
    expect(report.parameters.maxOldSpaceMb).toBe(2048);
  });

  it("prints route count and duration estimate before measuring", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-out-"));
    const progress: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir, onProgress: (m) => progress.push(m) },
      makeDeps([])
    );
    expect(progress.some((message) => /1 routes discovered · estimated ≈ 26s–4m/.test(message))).toBe(
      true
    );
  });

  it("estimates from measurable routes only and reports both counts", async () => {
    const appDir = await makeAppDir({
      "/page": "app/page.js",
      "/favicon.ico/route": "app/favicon.ico/route.js",
      "/(.)photo/page": "app/(.)photo/page.js",
    });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-out-"));
    const progress: string[] = [];
    const events: string[] = [];
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir, onProgress: (m) => progress.push(m) },
      makeDeps(events)
    );

    expect(
      progress.some((message) => /3 routes discovered · 1 measurable · estimated ≈/.test(message))
    ).toBe(true);
    // The estimate must match what one measurable route costs, not three.
    expect(progress.some((message) => message.includes("≈ 26s–4m"))).toBe(true);
    expect(events.filter((event) => event.startsWith("ritual:"))).toEqual(["ritual:/"]);

    const favicon = report.routes.find((route) => route.route === "/favicon.ico");
    expect(favicon).toEqual({
      route: "/favicon.ico",
      status: "skipped",
      reason: "static asset served by a generated handler — no user code to leak",
    });
  });

  it("marks remaining routes interrupted when the signal aborts", async () => {
    const appDir = await makeAppDir({
      "/a/page": "app/a/page.js",
      "/b/page": "app/b/page.js",
      "/c/page": "app/c/page.js",
    });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-out-"));
    const aborter = new AbortController();
    const deps = makeDeps([]);
    let measured = 0;
    const abortingDeps: RunnerDeps = {
      ...deps,
      ritual: async (options) => {
        measured += 1;
        if (measured === 1) {
          aborter.abort();
        }
        return deps.ritual(options);
      },
    };

    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir, signal: aborter.signal },
      abortingDeps
    );

    expect(measured).toBe(1);
    const statuses = report.routes.map((route) => `${route.route}:${route.status}`);
    expect(statuses).toEqual(["/a:measured", "/b:skipped", "/c:skipped"]);
    const interrupted = report.routes.filter(
      (route) => route.status === "skipped" && route.reason === "interrupted"
    );
    expect(interrupted).toHaveLength(2);
    // The partial report still persisted.
    expect(JSON.parse(await readFile(path.join(report.workDir, "run.json"), "utf8"))).toEqual(report);
  });

  it("captures the environment and writes the evidence bundle", async () => {
    const appDir = await makeAppDir({
      "/page": "app/page.js",
      "/leaky/page": "app/leaky/page.js",
    });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-out-"));

    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir },
      makeDeps([])
    );

    expect(report.environment.nodeVersion).toBe(process.version);
    expect(report.environment.nextVersion).toBe("16.0.1");
    expect(report.parameters.loadRequests).toBe(5000);
    // The measurement regime belongs on the record: a verdict whose gate and
    // heap cap are not written down cannot be reproduced or argued with.
    expect(report.parameters.minGrowthPerCycle).toBe(256 * 1024);
    expect(report.parameters.maxOldSpaceMb).toBe(512);

    const html = await readFile(report.bundle.htmlReport, "utf8");
    expect(html).toContain("next-leak report");
    expect(html).toContain("heap cap 512 MB");
    expect(html).toContain("growth gate 256 KiB/cycle");
    // /leaky's fake ritual verdict is leak → exactly one issue draft.
    expect(report.bundle.issues).toHaveLength(1);
    const issue = report.bundle.issues[0];
    if (issue === undefined) {
      throw new Error("expected an issue draft");
    }
    expect(issue.file.endsWith("ISSUE-leaky.md")).toBe(true);
    const markdown = await readFile(issue.file, "utf8");
    expect(markdown).toContain("# Memory leak on route `/leaky`");
  });
});

describe("routeSlug", () => {
  it("never collapses distinct routes onto the same slug", () => {
    const routes = ["/a/b", "/a_b", "/", "/ñ", "/es/x", "/es-x", "/[lang]/x", "/[lang]_x"];
    const slugs = routes.map(routeSlug);
    expect(new Set(slugs).size).toBe(routes.length);
    // Readable for the common cases.
    expect(routeSlug("/")).toBe("root");
    expect(routeSlug("/a/b")).toBe("a_b");
  });

  it("is deterministic", () => {
    expect(routeSlug("/ñ")).toBe(routeSlug("/ñ"));
  });
});

// The diff names the retaining object; the verdict does not depend on it.
// Measured 2026-08-18 on the vercel/next.js#97424 reproduction: a 1.7 GB
// snapshot cannot be read into a single string, node:fs threw, and a finished
// measurement went down with the whole run.
describe("a failed snapshot diff does not lose the measurement", () => {
  it("keeps the verdict and says the diff is unavailable", async () => {
    const events: string[] = [];
    const appDir = await makeAppDir({ "/leaky/page": "app/leaky/page.js" });
    const messages: string[] = [];
    const report = await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        onProgress: (message) => messages.push(message),
      },
      {
        ...makeDeps(events),
        diff: async () => {
          throw new Error("heap snapshot is 1740 MB, past the 512 MB a single string can hold");
        },
      }
    );

    const route = report.routes.find((entry) => entry.route === "/leaky");
    if (route?.status !== "measured") {
      throw new Error("the measurement must survive a failed diff");
    }
    expect(route.trend.verdict).toBe("leak");
    expect(route.diff).toBeNull();
    expect(messages.some((message) => message.includes("snapshot diff unavailable"))).toBe(true);
    expect(messages.some((message) => message.includes("1740 MB"))).toBe(true);
  });
});

// A cached route driven with keys it has never served fills its store while
// being measured. The verdict has to know, or it reports the cache as a leak —
// which is exactly what happened on a `use cache` route measured against
// Next 16.3.3 on 2026-08-27: +603 MB/1000 requests, all of it the cache.
describe("cache-driven routes", () => {
  async function cacheDrivenFlagFor(
    appPaths: Record<string, string>,
    config?: Record<string, unknown>
  ): Promise<boolean | undefined> {
    const appDir = await makeAppDir(appPaths);
    await writeFile(
      path.join(appDir, ".next", "prerender-manifest.json"),
      JSON.stringify({
        routes: { "/": { initialRevalidateSeconds: 900 } },
        preview: { previewModeId: "preview-id" },
      })
    );
    if (config !== undefined) {
      await writeFile(path.join(appDir, "next-leak.config.json"), JSON.stringify(config));
    }
    let seen: boolean | undefined;
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          seen = options.cacheDriven;
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );
    return seen;
  }

  it("marks an ISR route driven with unbounded keys", async () => {
    expect(await cacheDrivenFlagFor({ "/page": "app/page.js" })).toBe(true);
  });

  it("does not mark a route that is not served from the ISR cache", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    let seen: boolean | undefined;
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          seen = options.cacheDriven;
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );
    expect(seen).toBeUndefined();
  });

  it("does not mark an ISR route whose key set is bounded", async () => {
    // `{n%5}` revisits the same five keys, so the store settles and growth
    // beyond it is not the cache filling up.
    const flag = await cacheDrivenFlagFor(
      { "/page": "app/page.js" },
      { query: { "/": "page={n%5}" } }
    );
    expect(flag).toBeUndefined();
  });
});

// run.json is what a maintainer re-reads months later. A verdict whose
// alternative explanation lives only in the terminal is a verdict that will be
// misread once the scrollback is gone.
describe("cache-driven context survives serialization", () => {
  it("writes the cache-driven fact to run.json alongside the verdict", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          const result = ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
          return { ...result, trend: { ...result.trend, cacheDriven: true as const } };
        },
      }
    );
    const persisted = JSON.parse(
      await readFile(path.join(report.workDir, "run.json"), "utf8")
    ) as { routes: { trend?: { cacheDriven?: boolean } }[] };

    expect(persisted.routes[0]?.trend?.cacheDriven).toBe(true);
  });
});

// A decelerating curve always ends the measured window still growing, because
// `saturating` requires every cycle to clear the gate. Where it settles is
// outside what was measured, so the run goes back for a longer look.
describe("saturating routes are measured again", () => {
  function saturatingResult(route: string) {
    const result = ritualResult(route, [28 * MB, 30 * MB, 38 * MB, 42 * MB, 43.5 * MB]);
    return {
      ...result,
      trend: { ...result.trend, verdict: "saturating" as const, growthPerCycle: 4.5 * MB },
    };
  }

  it("goes back for a longer window, exactly once", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const progressLines: string[] = [];
    let passes = 0;
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (m) => progressLines.push(m) },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          passes += 1;
          return saturatingResult(options.route);
        },
      }
    );

    expect(passes).toBe(2);
    expect(
      progressLines.some(
        (line) =>
          line.includes("re-measuring / with 8 cycles") &&
          line.includes("still decelerating when the window ran out")
      )
    ).toBe(true);
  });

  it("stays on one pass when the caller opted out", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    let passes = 0;
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", resolveInconclusive: false },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          passes += 1;
          return saturatingResult(options.route);
        },
      }
    );
    expect(passes).toBe(1);
  });

  it("leaves a leak and a stable route on one pass", async () => {
    const appDir = await makeAppDir({ "/leaky/page": "app/leaky/page.js" });
    let passes = 0;
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          passes += 1;
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );
    expect(passes).toBe(1);
  });
});

