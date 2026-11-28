import { cp, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HeapExhaustedError, type RitualResult } from "./ritual.js";
import {
  aggregateRepetitions,
  estimateRun,
  formatDuration,
  remainingNote,
  worstCasePasses,
  formatEstimate,
  routeSlug,
  runMeasurement,
  type RouteReport,
  type RunnerDeps,
} from "./runner.js";
import { warrantsIssueDraft } from "./confidence.js";
import { minGrowthFor } from "./trend.js";
import { makeRunReport } from "./run-report.fixture.js";
import type { TrendVerdict } from "./trend.js";

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
        line.includes(
          "(one pass per route at 250 req/s; a route measured again, confirmed and settled can take 10× as long)"
        )
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
    expect(without.some((line) => line.includes("(one pass per route at 250 req/s)"))).toBe(true);
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

describe("worstCasePasses", () => {
  // vercel/next.js#97938 slug route: 4 + 8 + 4 + 8 + 16 cycles for a 4-cycle run.
  it("counts the passes, the confirmation's and the settling pass", () => {
    expect(worstCasePasses(4)).toBe(10);
    expect(worstCasePasses(10)).toBe(10);
    // Re-measurement never drops below 6 cycles: 3 + 6 + 3 + 6 + 12.
    expect(worstCasePasses(3)).toBe(10);
    // 2 + 6 + 2 + 6 + 12 over 2.
    expect(worstCasePasses(2)).toBe(14);
    // At 50 cycles the settling pass (100, the cap) is no longer than the
    // re-measurement (100) either, so it never runs: 50 + 100 + 50 + 100 over 50.
    expect(worstCasePasses(50)).toBe(6);
    // At 40 it still is: 40 + 80 + 40 + 80 + 100 over 40.
    expect(worstCasePasses(40)).toBe(9);
    // At 60 it would not be (100 against 120), so it never runs: 60 + 120 + 60 + 120 over 60.
    expect(worstCasePasses(60)).toBe(6);
  });
});

describe("remainingNote", () => {
  const measured = (loadSeconds: number) => {
    const route = makeRunReport().routes.find((entry) => entry.status === "measured");
    if (route?.status !== "measured") throw new Error("fixture has no measured route");
    return {
      ...route,
      requestsPerCycle: 300,
      timings: [
        { phase: "warm-up", seconds: 2 },
        { phase: "cycle 1 load", seconds: loadSeconds },
        { phase: "cycle 2 load", seconds: loadSeconds },
      ],
    };
  };

  it("prices the routes left at the mean so far", () => {
    expect(remainingNote(3, 120, undefined)).toBe("3 routes left · ≈ 6m at the pace so far");
    expect(remainingNote(1, 45, undefined)).toBe("1 route left · ≈ 45s at the pace so far");
  });

  it("says when the app served well under the throughput the estimate assumed", () => {
    // The #97938 slug route: 300 requests in 46 s, 6.5 req/s.
    const last = measured(46);
    expect(remainingNote(2, 600, last)).toBe(
      `2 routes left · ≈ 20m at the pace so far — ${last.route} served 6.5 req/s, not the 250 the estimate assumed`
    );
  });

  it("stays quiet about throughput at or above half the assumption", () => {
    // 300 requests in 2.4 s is 125 req/s, exactly half.
    expect(remainingNote(1, 30, measured(2.4))).toBe("1 route left · ≈ 30s at the pace so far");
    expect(remainingNote(1, 30, measured(2.5))).toContain("served 120.0 req/s");
  });

  it("does not guess a throughput for a route that did not measure", () => {
    expect(remainingNote(1, 30, { route: "/x", status: "failed", reason: "boom" })).toBe(
      "1 route left · ≈ 30s at the pace so far"
    );
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

  it("marks a template that caches each new key with nothing prerendered", async () => {
    // vercel/next.js#99335: `generateStaticParams() → []` leaves the template
    // only in `dynamicRoutes`, with a blocking fallback and no period anywhere.
    // It used to be measured as not-ISR, so the cache-residency note and the
    // remedy audit never saw the cache filling under the load.
    const appDir = await makeAppDir({ "/blog/[slug]/page": "app/blog/[slug]/page.js" });
    await writeFile(
      path.join(appDir, ".next", "prerender-manifest.json"),
      JSON.stringify({
        routes: {},
        dynamicRoutes: { "/blog/[slug]": { fallback: null } },
        preview: { previewModeId: "preview-id" },
      })
    );
    await writeFile(
      path.join(appDir, "next-leak.config.json"),
      JSON.stringify({ params: { slug: "post-{n}" } })
    );
    let seen: boolean | undefined;
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          seen = options.cacheDriven;
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );
    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("expected a measured route");

    expect(seen).toBe(true);
    expect(route.servedFromIsrCache).toBe(true);
    expect(route.revalidatedEverySeconds).toBeUndefined();
    expect(route.revalidationDriven).toBeUndefined();
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

// An absent diff and an unreadable snapshot both leave `diff: null`. One says
// nothing grew enough to name; the other says the evidence could not be read.
// A report that conflates them turns a hole in the evidence into a finding.
describe("attribution gaps are distinguishable", () => {
  async function runWithDiff(diff: RunnerDeps["diff"]) {
    const appDir = await makeAppDir({ "/leaky/page": "app/leaky/page.js" });
    return runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      { ...makeDeps([]), diff }
    );
  }

  it("records an unreadable snapshot as a gap, with advice sized to the run", async () => {
    const { constants } = await import("node:buffer");
    const { SnapshotError } = await import("./heap-diff.js");
    const report = await runWithDiff(async () => {
      throw new SnapshotError("heap snapshot parses 1024 MB", constants.MAX_STRING_LENGTH * 2);
    });

    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("route should be measured");
    expect(route.diff).toBeNull();
    expect(route.attributionGap?.reason).toBe("snapshot-unreadable");
    // 5000 requests produced twice the ceiling, so a fifth of that is the
    // advice: 5000 × (1/2) × 0.8 = 2000.
    expect(route.attributionGap?.detail).toContain("--requests 2000");
  });

  it("leaves no gap when the diff ran and simply found nothing", async () => {
    const report = await runWithDiff(async () => ({
      typeDeltas: [],
      grownNodes: [],
      newNodes: [],
    }));

    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("route should be measured");
    expect(route.attributionGap).toBeUndefined();
  });

  it("records a snapshot that was never taken as its own kind of gap", async () => {
    // Distinct from `snapshot-unreadable`: there is no file to parse, because
    // the measured process never handed one over. The cycles that did complete
    // still carry a verdict, and the run must keep it — reported on
    // vercel/next.js#84648, where the route came back as a bare failure.
    const appDir = await makeAppDir({ "/leaky/page": "app/leaky/page.js" });
    let diffed = false;
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      {
        ...makeDeps([]),
        ritual: async (options) => ({
          ...ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]),
          afterSnapshot: "",
          snapshotFailure: "control channel /snapshot?name=after wrote nothing for 300s",
        }),
        diff: async () => {
          diffed = true;
          throw new Error("must not diff without a snapshot");
        },
      }
    );

    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("route should be measured");
    expect(route.trend.verdict).toBe("leak");
    expect(route.attributionGap?.reason).toBe("snapshot-unavailable");
    expect(route.attributionGap?.detail).toContain("wrote nothing for 300s");
    expect(route.diff).toBeNull();
    expect(diffed).toBe(false);
  });

  it("persists the gap to run.json", async () => {
    const { SnapshotError } = await import("./heap-diff.js");
    const report = await runWithDiff(async () => {
      throw new SnapshotError("heap snapshot parses 900 MB");
    });
    const persisted = JSON.parse(
      await readFile(path.join(report.workDir, "run.json"), "utf8")
    ) as { routes: { attributionGap?: { reason: string } }[] };

    expect(persisted.routes[0]?.attributionGap?.reason).toBe("snapshot-unreadable");
  });
});

describe("aggregateRepetitions", () => {
  const measuredRoute = (verdict: TrendVerdict, growthPerCycle: number): RouteReport => {
    const report = makeRunReport();
    const route = report.routes[1];
    if (route?.status !== "measured") throw new Error("fixture broken");
    return {
      ...route,
      requestsPerCycle: 1000,
      trend: { ...route.trend, verdict, growthPerCycle },
      confidence: { level: "high", warnings: [] },
    };
  };

  it("keeps the verdict when every repetition agrees", () => {
    const aggregate = aggregateRepetitions([
      measuredRoute("leak", 2 * MB),
      measuredRoute("leak", 3 * MB),
    ]);
    if (aggregate.status !== "measured") throw new Error("expected a measured route");
    expect(aggregate.trend.verdict).toBe("leak");
    expect(aggregate.confidence.supersededVerdict).toBeUndefined();
    expect(aggregate.repetitions).toEqual([
      { verdict: "leak", growthPer1000Requests: 2 * MB },
      { verdict: "leak", growthPer1000Requests: 3 * MB },
    ]);
  });

  // Two runs of one build disagreeing is the finding, not an average to take:
  // vercel/next.js#84648 gave 602, 826 and 875 MB and then 39 MB on a fourth.
  it("supersedes a disagreement with inconclusive and says so", () => {
    const aggregate = aggregateRepetitions([
      measuredRoute("leak", 2 * MB),
      measuredRoute("stable", 0.01 * MB),
    ]);
    if (aggregate.status !== "measured") throw new Error("expected a measured route");
    expect(aggregate.confidence.supersededVerdict).toBe("inconclusive");
    expect(aggregate.confidence.level).toBe("low");
    expect(aggregate.confidence.warnings.map((warning) => warning.code)).toContain(
      "repetitions-disagree"
    );
  });

  it("withholds an issue draft when repetitions disagree", () => {
    const aggregate = aggregateRepetitions([
      measuredRoute("leak", 2 * MB),
      measuredRoute("stable", 0.01 * MB),
    ]);
    if (aggregate.status !== "measured") throw new Error("expected a measured route");
    expect(warrantsIssueDraft(aggregate)).toBe(false);
  });

  // A confirmation whose audit withdrew its leak did not agree with the first
  // pass: counting raw curves called them unanimous and drafted an issue.
  it("judges each repetition by the verdict it supports, not its raw curve", () => {
    const withdrawn = measuredRoute("leak", 2 * MB);
    if (withdrawn.status !== "measured") throw new Error("expected a measured route");
    const aggregate = aggregateRepetitions([
      measuredRoute("leak", 2 * MB),
      { ...withdrawn, confidence: { ...withdrawn.confidence, supersededVerdict: "inconclusive" } },
    ]);
    if (aggregate.status !== "measured") throw new Error("expected a measured route");
    expect(aggregate.repetitions?.map((entry) => entry.verdict)).toEqual(["leak", "inconclusive"]);
    expect(aggregate.confidence.supersededVerdict).toBe("inconclusive");
    expect(warrantsIssueDraft(aggregate)).toBe(false);
  });

  // A repetition that failed is not a disagreement to average away.
  it("returns the failure when one repetition did not measure", () => {
    const failed: RouteReport = { route: "/x", status: "failed", reason: "port race lost" };
    const aggregate = aggregateRepetitions([measuredRoute("leak", 2 * MB), failed]);
    expect(aggregate.status).toBe("failed");
  });
});

describe("repeat runs the whole measurement again", () => {
  it("measures a route once per repetition and records each result", async () => {
    // The loop itself, not the aggregation: a `--repeat` that quietly measured
    // once and copied the result would pass every aggregation test above.
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    // `ritualResult` derives its verdict from the route name, so each
    // repetition's trend is set explicitly here.
    const verdicts = ["leak", "leak", "stable"] as const;
    let call = 0;
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", repeat: 3 },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          const verdict = verdicts[call] ?? "leak";
          call += 1;
          const base = ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
          return {
            ...base,
            trend: {
              verdict,
              growthPerCycle: verdict === "leak" ? 2.5 * MB : 0.1 * MB,
              deltas: [],
            },
          };
        },
      }
    );

    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("expected a measured route");
    expect(call).toBe(3);
    expect(route.repetitions?.map((entry) => entry.verdict)).toEqual(["leak", "leak", "stable"]);
    // Two leaks and a flat run: the disagreement is what gets reported.
    expect(route.confidence.supersededVerdict).toBe("inconclusive");
  });

  it("leaves the report untouched when repeat is 1", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    let call = 0;
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", repeat: 1 },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          call += 1;
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );
    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("expected a measured route");
    expect(call).toBe(1);
    expect(route.repetitions).toBeUndefined();
  });
});

// A leak whose growth sits under twice the gate did not hold between processes:
// on the vercel/next.js#97938 reproduction (16.3.6, Node 22.23) one run came out
// `stable` with high confidence and the next `leak` at +0.50 MB per cycle.
describe("confirming a borderline leak from a fresh server", () => {
  type Pass = {
    verdict: "leak" | "stable" | "saturating" | "pressure";
    growth: number;
    deltas?: number[];
    /** The heap was still moving when sampled: a warning about this process. */
    unsettled?: boolean;
  };
  const BORDERLINE: Pass = { verdict: "leak", growth: 0.3 * MB };
  const CLEAR: Pass = { verdict: "leak", growth: 2.5 * MB };
  const FLAT: Pass = { verdict: "stable", growth: 0.1 * MB };
  const BORDERLINE_CONFIRMED: Pass = { verdict: "leak", growth: 2.5 * MB };

  async function run(
    passes: readonly Pass[],
    options: {
      repeat?: number;
      resolveInconclusive?: boolean;
      abortAfterFirst?: boolean;
      confirmBudgetMs?: number;
      cycles?: number;
      /** Wall time each ritual takes on the fake clock. */
      passMs?: number;
    } = {}
  ) {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const progress: string[] = [];
    const workDirs: string[] = [];
    const controller = new AbortController();
    let call = 0;
    const { abortAfterFirst, passMs, ...runOptions } = options;
    let clockMs = 0;
    const cycleCounts: Array<number | undefined> = [];
    const report = await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        onProgress: (line) => progress.push(line),
        signal: controller.signal,
        ...runOptions,
      },
      {
        ...makeDeps([]),
        now: () => clockMs,
        ritual: async (ritualOptions) => {
          const pass = passes[call] ?? FLAT;
          call += 1;
          clockMs += passMs ?? 60_000;
          workDirs.push(ritualOptions.workDir);
          cycleCounts.push(ritualOptions.cycles);
          if (abortAfterFirst === true) controller.abort();
          const base = ritualResult(ritualOptions.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
          return {
            ...base,
            ...(pass.unsettled === true && {
              settleOutcomes: [{ phase: "cycle 1", status: "moving" as const, polls: 40 }],
            }),
            trend: { verdict: pass.verdict, growthPerCycle: pass.growth, deltas: pass.deltas ?? [] },
          };
        },
      }
    );
    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("expected a measured route");
    return { route, calls: call, progress, workDirs, cycleCounts };
  }

  // vercel/next.js#97938 on 16.3.6 / Node 22: three of five runs ended in a
  // disagreement at 4 and 8 cycles; 16 showed the leak.
  describe("settling a disagreement over 16 cycles", () => {
    it("measures once more over four times the cycles and reports that pass", async () => {
      const { route, calls, cycleCounts, progress, workDirs } = await run([
        { ...FLAT, unsettled: true },
        BORDERLINE_CONFIRMED,
        CLEAR,
      ]);

      expect(calls).toBe(3);
      expect(cycleCounts).toEqual([undefined, undefined, 16]);
      expect(workDirs[2]).toMatch(/-settle$/);
      expect(route.trend.verdict).toBe("leak");
      expect(route.resolvedWithCycles).toBe(16);
      expect(route.settledBy).toEqual({ cycles: 16 });
      expect(route.confidence.supersededVerdict).toBeUndefined();
      expect(route.repetitions?.map((entry) => entry.verdict)).toEqual(["stable", "leak", "leak"]);
      // CLEAR: 2.5 MB per cycle over 5000 requests.
      expect(route.repetitions?.[2]?.growthPer1000Requests).toBe(0.5 * MB);
      expect(progress.find((line) => line.startsWith("settling"))).toMatch(
        /^settling .* over 16 cycles from a fresh server: the two passes disagreed \(≈ 60s at the pace of the first pass\)$/
      );
    });

    it("lets the long pass acquit as well as accuse", async () => {
      const { route } = await run([BORDERLINE, FLAT, FLAT]);
      expect(route.trend.verdict).toBe("stable");
      expect(route.repetitions?.map((entry) => entry.verdict)).toEqual(["leak", "stable", "stable"]);
    });

    it("prices the long pass from the first pass's cycles", async () => {
      // Each fake pass is 60 s of clock, but its timings say 4 cycles of 50 s
      // plus 20 s fixed: 16 cycles is 820 s, over a budget of 10 minutes.
      const appDir = await makeAppDir({ "/page": "app/page.js" });
      let clockMs = 0;
      let call = 0;
      const progress: string[] = [];
      await runMeasurement(
        {
          appDir,
          bootstrapPath: "/fake/bootstrap.js",
          confirmBudgetMs: 10 * 60_000,
          onProgress: (line) => progress.push(line),
        },
        {
          ...makeDeps([]),
          now: () => clockMs,
          ritual: async (ritualOptions) => {
            call += 1;
            clockMs += 60_000;
            const base = ritualResult(ritualOptions.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
            return {
              ...base,
              timings: [
                { phase: "warm-up", seconds: 2 },
                ...[1, 2, 3, 4].map((cycle) => ({ phase: `cycle ${cycle} load`, seconds: 50 })),
                { phase: "after snapshot", seconds: 18 },
              ],
              ...(call === 1 && {
                settleOutcomes: [{ phase: "cycle 1", status: "moving" as const, polls: 40 }],
              }),
              trend:
                call === 1
                  ? { verdict: "stable" as const, growthPerCycle: 0.1 * MB, deltas: [] }
                  : { verdict: "leak" as const, growthPerCycle: 2.5 * MB, deltas: [] },
            };
          },
        }
      );

      expect(call).toBe(2);
      expect(progress.find((line) => line.startsWith("not settling"))).toMatch(
        /over 16 cycles: the confirmation budget is spent — raise --confirm-budget to settle it$/
      );
    });

    it("spends the long pass from the budget", async () => {
      // 3 minutes, one per pass: /a's confirmation and long pass, then /b's
      // confirmation. Nothing is left to settle /b.
      const appDir = await makeAppDir({ "/a/page": "app/a/page.js", "/b/page": "app/b/page.js" });
      let clockMs = 0;
      const measured: string[] = [];
      await runMeasurement(
        { appDir, bootstrapPath: "/fake/bootstrap.js", confirmBudgetMs: 3 * 60_000 },
        {
          ...makeDeps([]),
          now: () => clockMs,
          ritual: async (ritualOptions) => {
            clockMs += 60_000;
            measured.push(ritualOptions.route);
            const count = measured.filter((route) => route === ritualOptions.route).length;
            const base = ritualResult(ritualOptions.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
            return {
              ...base,
              ...(count === 1 && {
                settleOutcomes: [{ phase: "cycle 1", status: "moving" as const, polls: 40 }],
              }),
              trend:
                count === 2
                  ? { verdict: "leak" as const, growthPerCycle: 2.5 * MB, deltas: [] }
                  : { verdict: "stable" as const, growthPerCycle: 0.1 * MB, deltas: [] },
            };
          },
        }
      );

      expect(measured).toEqual(["/a", "/a", "/a", "/b", "/b"]);
    });

    it("keeps the disagreement when the long pass fails", async () => {
      const appDir = await makeAppDir({ "/page": "app/page.js" });
      let call = 0;
      const progress: string[] = [];
      const report = await runMeasurement(
        { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (line) => progress.push(line) },
        {
          ...makeDeps([]),
          ritual: async (ritualOptions) => {
            call += 1;
            if (call === 3) throw new Error("port taken");
            const base = ritualResult(ritualOptions.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
            return {
              ...base,
              ...(call === 1 && {
                settleOutcomes: [{ phase: "cycle 1", status: "moving" as const, polls: 40 }],
              }),
              trend:
                call === 1
                  ? { verdict: "stable" as const, growthPerCycle: 0.1 * MB, deltas: [] }
                  : { verdict: "leak" as const, growthPerCycle: 2.5 * MB, deltas: [] },
            };
          },
        }
      );

      const route = report.routes[0];
      if (route?.status !== "measured") throw new Error("expected a measured route");
      expect(call).toBe(3);
      expect(route.confidence.supersededVerdict).toBe("inconclusive");
      expect(progress.some((line) => line.endsWith("did not measure (port taken) — keeping the disagreement"))).toBe(true);
    });

    it("does not start the long pass after an interrupt during the confirmation", async () => {
      const appDir = await makeAppDir({ "/page": "app/page.js" });
      const controller = new AbortController();
      let call = 0;
      await runMeasurement(
        { appDir, bootstrapPath: "/fake/bootstrap.js", signal: controller.signal },
        {
          ...makeDeps([]),
          ritual: async (ritualOptions) => {
            call += 1;
            if (call === 2) controller.abort();
            const base = ritualResult(ritualOptions.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
            return {
              ...base,
              ...(call === 1 && {
                settleOutcomes: [{ phase: "cycle 1", status: "moving" as const, polls: 40 }],
              }),
              trend:
                call === 1
                  ? { verdict: "stable" as const, growthPerCycle: 0.1 * MB, deltas: [] }
                  : { verdict: "leak" as const, growthPerCycle: 2.5 * MB, deltas: [] },
            };
          },
        }
      );
      expect(call).toBe(2);
    });

    it("settles on the Node binary that disagreed", async () => {
      const appDir = await makeAppDir({ "/page": "app/page.js" });
      const seen: Array<{ nodePath: string | undefined; cycles: number | undefined }> = [];
      await runMeasurement(
        {
          appDir,
          bootstrapPath: "/fake/bootstrap.js",
          nodeBinaries: [
            { path: "/opt/node22/bin/node", version: "v22.23.5" },
            { path: "/opt/node24/bin/node", version: "v24.22.3" },
          ],
        },
        {
          ...makeDeps([]),
          ritual: async (ritualOptions) => {
            seen.push({ nodePath: ritualOptions.nodePath, cycles: ritualOptions.cycles });
            const onNode24 = ritualOptions.nodePath === "/opt/node24/bin/node";
            const count = seen.filter((entry) => entry.nodePath === ritualOptions.nodePath).length;
            const base = ritualResult(ritualOptions.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
            return {
              ...base,
              ...(onNode24 &&
                count === 1 && {
                  settleOutcomes: [{ phase: "cycle 1", status: "moving" as const, polls: 40 }],
                }),
              trend:
                onNode24 && count === 2
                  ? { verdict: "leak" as const, growthPerCycle: 2.5 * MB, deltas: [] }
                  : { verdict: "stable" as const, growthPerCycle: 0.1 * MB, deltas: [] },
            };
          },
        }
      );

      expect(seen).toEqual([
        { nodePath: "/opt/node22/bin/node", cycles: undefined },
        { nodePath: "/opt/node24/bin/node", cycles: undefined },
        { nodePath: "/opt/node24/bin/node", cycles: undefined },
        { nodePath: "/opt/node24/bin/node", cycles: 16 },
      ]);
    });

    // The #97938 slug route at 6.5 req/s: 18 minutes a pass. Under the old
    // half-hour default the confirmation left 12 minutes and the settling pass
    // never ran.
    it("settles a slow route by default, and only a cap given stops it", async () => {
      const slow = [{ ...FLAT, unsettled: true }, CLEAR, CLEAR] as const;
      const byDefault = await run([...slow], { passMs: 18 * 60_000 });
      expect(byDefault.calls).toBe(3);
      expect(byDefault.route.trend.verdict).toBe("leak");

      const capped = await run([...slow], { passMs: 18 * 60_000, confirmBudgetMs: 30 * 60_000 });
      expect(capped.calls).toBe(2);
      expect(capped.route.confidence.supersededVerdict).toBe("inconclusive");
    });

    it("does not settle when the cap leaves it no longer than the re-measurement", async () => {
      // --cycles 60: the re-measurement runs 120 cycles, the settling pass
      // would be capped at 100.
      const { calls, route } = await run([{ ...FLAT, unsettled: true }, CLEAR, CLEAR], { cycles: 60 });
      expect(calls).toBe(2);
      expect(route.confidence.supersededVerdict).toBe("inconclusive");
    });

    it("settles when the long pass fits the budget exactly", async () => {
      // One minute per pass: the confirmation spends 1, the long pass needs 1.
      const fits = await run([{ ...FLAT, unsettled: true }, CLEAR, CLEAR], {
        confirmBudgetMs: 2 * 60_000,
      });
      expect(fits.calls).toBe(3);
      const short = await run([{ ...FLAT, unsettled: true }, CLEAR, CLEAR], {
        confirmBudgetMs: 2 * 60_000 - 1,
      });
      expect(short.calls).toBe(2);
    });

    it("reports a long pass that ran out of heap as the finding", async () => {
      const appDir = await makeAppDir({ "/page": "app/page.js" });
      let call = 0;
      const progress: string[] = [];
      const report = await runMeasurement(
        { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (line) => progress.push(line) },
        {
          ...makeDeps([]),
          ritual: async (ritualOptions) => {
            call += 1;
            const base = ritualResult(ritualOptions.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
            if (call === 3) {
              throw new HeapExhaustedError("ran out of heap at cycle 11", {
                memorySamples: base.memorySamples,
                peaks: base.peaks,
                unreclaimedSamples: [],
                cyclesCompleted: 10,
                cyclesRequested: 16,
                requestsPerCycle: 5000,
                baselineSnapshot: base.baselineSnapshot,
              });
            }
            return {
              ...base,
              ...(call === 1 && {
                settleOutcomes: [{ phase: "cycle 1", status: "moving" as const, polls: 40 }],
              }),
              trend:
                call === 1
                  ? { verdict: "stable" as const, growthPerCycle: 0.1 * MB, deltas: [] }
                  : { verdict: "leak" as const, growthPerCycle: 2.5 * MB, deltas: [] },
            };
          },
        }
      );

      expect(report.routes[0]).toMatchObject({
        status: "died-of-heap",
        cyclesCompleted: 10,
        cyclesRequested: 16,
      });
      expect(progress).toContain("leak / (1/1): ran out of heap at cycle 11");
    });

    // Run 2 of the #97938 slug route: two stables at 8 cycles, both growing
    // over the gate, agreed, and the leak was never looked at longer.
    it("settles two agreeing stables that both grew over the threshold", async () => {
      const grew = { verdict: "stable" as const, growth: 2 * minGrowthFor(5000) };
      const { calls, route, progress } = await run([grew, grew, CLEAR]);

      expect(calls).toBe(3);
      expect(route.trend.verdict).toBe("leak");
      expect(route.settledBy).toEqual({ cycles: 16 });
      expect(progress.find((line) => line.startsWith("settling"))).toMatch(
        /over 16 cycles from a fresh server: both passes were stable while growing over the threshold/
      );
    });

    it("reports a confirmation that ran out of heap, without settling", async () => {
      const appDir = await makeAppDir({ "/page": "app/page.js" });
      let call = 0;
      const report = await runMeasurement(
        { appDir, bootstrapPath: "/fake/bootstrap.js" },
        {
          ...makeDeps([]),
          ritual: async (options) => {
            call += 1;
            const base = ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
            if (call === 2) {
              throw new HeapExhaustedError("ran out of heap at cycle 3", {
                memorySamples: base.memorySamples,
                peaks: base.peaks,
                unreclaimedSamples: [],
                cyclesCompleted: 2,
                cyclesRequested: 4,
                requestsPerCycle: 5000,
                baselineSnapshot: base.baselineSnapshot,
              });
            }
            return {
              ...base,
              trend: { verdict: "stable" as const, growthPerCycle: 2 * minGrowthFor(5000), deltas: [] },
            };
          },
        }
      );

      expect(call).toBe(2);
      expect(report.routes[0]?.status).toBe("died-of-heap");
    });

    it("does not settle when only one stable grew over the threshold", async () => {
      const grew = { verdict: "stable" as const, growth: 2 * minGrowthFor(5000) };
      expect((await run([grew, FLAT])).calls).toBe(2);
    });

    it("does not escalate when the passes agree, or under --no-resolve", async () => {
      expect((await run([{ ...FLAT, unsettled: true }, FLAT])).route.settledBy).toBeUndefined();
      expect((await run([{ ...FLAT, unsettled: true }, FLAT])).calls).toBe(2);
      expect((await run([BORDERLINE, FLAT], { resolveInconclusive: false })).calls).toBe(1);
    });
  });

  it("keeps the verdict when the confirmation agrees", async () => {
    const { route, calls, progress } = await run([BORDERLINE, BORDERLINE]);

    expect(calls).toBe(2);
    expect(route.repetitions?.map((entry) => entry.verdict)).toEqual(["leak", "leak"]);
    expect(route.confidence.supersededVerdict).toBeUndefined();
    expect(
      progress.some((line) =>
        line.includes("from a fresh server: its growth barely clears the threshold")
      )
    ).toBe(true);
  });

  it("measures the confirmation in a directory of its own", async () => {
    const { workDirs } = await run([BORDERLINE, BORDERLINE]);

    expect(workDirs).toHaveLength(2);
    expect(workDirs[1]?.endsWith("-confirm")).toBe(true);
    expect(workDirs[0]).not.toBe(workDirs[1]);
  });

  it("confirms a clear but spiky leak within the budget, and not without one", async () => {
    // Spiky growth: one cycle many times the smallest, and far above the gate.
    const spiky: Pass = {
      verdict: "leak",
      growth: 2.8 * MB,
      deltas: [10 * MB, 1 * MB, 1 * MB, 1 * MB, 1 * MB],
    };

    const within = await run([spiky, spiky]);
    expect(within.calls).toBe(2);
    expect(within.progress.find((line) => line.startsWith("confirming"))).toMatch(
      /from a fresh server: low confidence \(spiky-growth\) \(≈ \d+s — what the first pass took\)$/
    );

    const off = await run([spiky, spiky], { confirmBudgetMs: 0 });
    expect(off.calls).toBe(1);
  });

  // vercel/next.js#97938 on 16.3.6 / Node 22: stable, leak, saturating, leak
  // across four runs. The stable half of that flip was never looked at again.
  it("confirms a low-confidence stable and reports a disagreement as inconclusive", async () => {
    // Budget for the confirmation and nothing more.
    const { route, calls } = await run([{ ...FLAT, unsettled: true }, BORDERLINE_CONFIRMED], {
      confirmBudgetMs: 60_000,
    });

    expect(calls).toBe(2);
    expect(route.repetitions?.map((entry) => entry.verdict)).toEqual(["stable", "leak"]);
    expect(route.confidence.supersededVerdict).toBe("inconclusive");
  });

  it("keeps a low-confidence stable both passes agree on", async () => {
    const { route, calls } = await run([{ ...FLAT, unsettled: true }, FLAT]);

    expect(calls).toBe(2);
    expect(route.repetitions?.map((entry) => entry.verdict)).toEqual(["stable", "stable"]);
    expect(route.confidence.supersededVerdict).toBeUndefined();
  });

  it("does not confirm a high-confidence stable", async () => {
    expect((await run([FLAT])).calls).toBe(1);
  });

  it("does not confirm a verdict whose only warning a second run cannot change", async () => {
    // Pressure is a peak that was observed; a second pass reaches it again.
    expect((await run([{ verdict: "pressure", growth: 0.1 * MB, unsettled: true }])).calls).toBe(1);
  });

  it("skips a confirmation the first pass says would overrun the budget", async () => {
    // First pass 5 minutes, 2 left.
    const { calls, progress } = await run([{ ...FLAT, unsettled: true }], {
      confirmBudgetMs: 2 * 60_000,
      passMs: 5 * 60_000,
    });

    expect(calls).toBe(1);
    expect(progress.find((line) => line.startsWith("not confirming"))).toMatch(
      /\(low confidence \(unsettled\)\): the confirmation budget is spent — raise --confirm-budget to confirm it$/
    );
  });

  it("confirms when the first pass fits the budget exactly", async () => {
    const { calls } = await run([{ ...FLAT, unsettled: true }, FLAT], {
      confirmBudgetMs: 5 * 60_000,
      passMs: 5 * 60_000,
    });

    expect(calls).toBe(2);
  });

  it("spends the budget across routes", async () => {
    // Two routes, each pass 4 minutes, 6 minutes of budget: the first route's
    // confirmation leaves 2, which the second route's 4-minute pass overruns.
    const appDir = await makeAppDir({ "/a/page": "app/a/page.js", "/b/page": "app/b/page.js" });
    let clockMs = 0;
    const measured: string[] = [];
    const progress: string[] = [];
    await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        confirmBudgetMs: 6 * 60_000,
        onProgress: (line) => progress.push(line),
      },
      {
        ...makeDeps([]),
        now: () => clockMs,
        ritual: async (ritualOptions) => {
          clockMs += 4 * 60_000;
          measured.push(ritualOptions.route);
          const base = ritualResult(ritualOptions.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
          return {
            ...base,
            settleOutcomes: [{ phase: "cycle 1", status: "moving" as const, polls: 40 }],
          };
        },
      }
    );

    expect(measured).toEqual(["/a", "/a", "/b"]);
    expect(progress.some((line) => line.startsWith("not confirming /b"))).toBe(true);
  });

  it("spends what the confirmation took, not the clock reading", async () => {
    // 9 minutes, 4-minute passes: the confirmation of /a leaves 5, enough for
    // /b's. Spending the clock reading (12 at that point) would leave none.
    const appDir = await makeAppDir({ "/a/page": "app/a/page.js", "/b/page": "app/b/page.js" });
    let clockMs = 0;
    const measured: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", confirmBudgetMs: 9 * 60_000 },
      {
        ...makeDeps([]),
        now: () => clockMs,
        ritual: async (ritualOptions) => {
          clockMs += 4 * 60_000;
          measured.push(ritualOptions.route);
          const base = ritualResult(ritualOptions.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
          return {
            ...base,
            settleOutcomes: [{ phase: "cycle 1", status: "moving" as const, polls: 40 }],
          };
        },
      }
    );

    expect(measured).toEqual(["/a", "/a", "/b", "/b"]);
  });

  it("confirms a borderline leak even with no budget", async () => {
    expect((await run([BORDERLINE, BORDERLINE], { confirmBudgetMs: 0 })).calls).toBe(2);
  });

  it("does not spend the budget on a borderline leak", async () => {
    // The borderline leak's confirmation is free; the stable route after it
    // still fits a budget of one pass.
    const appDir = await makeAppDir({ "/a/page": "app/a/page.js", "/b/page": "app/b/page.js" });
    let clockMs = 0;
    const measured: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", confirmBudgetMs: 60_000 },
      {
        ...makeDeps([]),
        now: () => clockMs,
        ritual: async (ritualOptions) => {
          clockMs += 60_000;
          measured.push(ritualOptions.route);
          const base = ritualResult(ritualOptions.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
          return ritualOptions.route === "/a"
            ? { ...base, trend: { verdict: "leak" as const, growthPerCycle: 0.3 * MB, deltas: [] } }
            : { ...base, settleOutcomes: [{ phase: "cycle 1", status: "moving" as const, polls: 40 }] };
        },
      }
    );

    expect(measured).toEqual(["/a", "/a", "/b", "/b"]);
  });

  it("leaves a borderline leak the audit already withdrew to re-measurement", async () => {
    // Three small deltas: thin evidence, so the verdict is already inconclusive
    // and goes back for more cycles instead of to a fresh-server confirmation.
    const thin: Pass = { verdict: "leak", growth: 0.3 * MB, deltas: [0.3 * MB, 0.3 * MB, 0.3 * MB] };
    const { calls, progress } = await run([thin, thin, thin]);

    // First pass, then the longer re-measurement, which is still withdrawn.
    expect(calls).toBe(2);
    expect(progress.some((line) => line.includes("from a fresh server"))).toBe(false);
  });

  it("does not start a confirmation after an interrupt", async () => {
    const { calls } = await run([BORDERLINE, BORDERLINE], { abortAfterFirst: true });

    expect(calls).toBe(1);
  });

  it("reports inconclusive when the confirmation disagrees and nothing can settle it", async () => {
    // No budget: the borderline confirmation still runs, the long pass does not.
    const { route, calls } = await run([BORDERLINE, FLAT], { confirmBudgetMs: 0 });

    expect(calls).toBe(2);
    expect(route.repetitions?.map((entry) => entry.verdict)).toEqual(["leak", "stable"]);
    expect(route.confidence.supersededVerdict).toBe("inconclusive");
    expect(route.confidence.warnings.some((warning) => warning.code === "repetitions-disagree")).toBe(true);
  });

  it("measures a clear leak once", async () => {
    const { route, calls } = await run([CLEAR]);

    expect(calls).toBe(1);
    expect(route.repetitions).toBeUndefined();
  });

  it("does not confirm verdicts other than leak", async () => {
    for (const pass of [FLAT, { verdict: "pressure", growth: 0.3 * MB }] as const) {
      const { calls } = await run([pass]);
      expect(calls).toBe(1);
    }
  });

  it("does not confirm under --no-resolve", async () => {
    const { route, calls } = await run([BORDERLINE], { resolveInconclusive: false });

    expect(calls).toBe(1);
    expect(route.repetitions).toBeUndefined();
  });

  it("adds nothing to the repetitions the user asked for", async () => {
    const { route, calls } = await run([BORDERLINE, BORDERLINE], { repeat: 2 });

    expect(calls).toBe(2);
    expect(route.repetitions).toHaveLength(2);
  });

  it("keeps the first pass when the confirmation fails to measure", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const progress: string[] = [];
    let call = 0;
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (line) => progress.push(line) },
      {
        ...makeDeps([]),
        ritual: async (ritualOptions) => {
          call += 1;
          if (call === 2) throw new Error("port race lost");
          const base = ritualResult(ritualOptions.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
          return { ...base, trend: { verdict: "leak", growthPerCycle: 0.3 * MB, deltas: [] } };
        },
      }
    );
    const route = report.routes[0];

    expect(call).toBe(2);
    expect(progress.some((line) => line.includes("keeping the first pass"))).toBe(true);
    expect(route?.status).toBe("measured");
    if (route?.status !== "measured") return;
    expect(route.trend.verdict).toBe("leak");
    expect(route.repetitions).toBeUndefined();
  });
});

// vercel/next.js#97938, 16.3.6: the same build held about 650 MB after 300
// requests on Node 22.23 and nothing on Node 24.22.
describe("measuring on chosen Node binaries", () => {
  const NODE22 = { path: "/opt/node22/bin/node", version: "v22.23.5" };
  const NODE24 = { path: "/opt/node24/bin/node", version: "v24.22.3" };

  async function run(
    nodeBinaries: Array<{ path: string; version: string }>,
    pass: (nodePath: string | undefined, call: number) => { verdict: "leak" | "stable"; growth: number; heldMb: number }
  ) {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const seen: Array<{ nodePath: string | undefined; workDir: string }> = [];
    const progress: string[] = [];
    let call = 0;
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", nodeBinaries, onProgress: (line) => progress.push(line) },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          seen.push({ nodePath: options.nodePath, workDir: options.workDir });
          const outcome = pass(options.nodePath, call);
          call += 1;
          const base = ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
          return {
            ...base,
            memorySamples: base.memorySamples.map((sample, index, all) =>
              index === all.length - 1 ? { ...sample, heapUsed: outcome.heldMb * MB, external: 0 } : sample
            ),
            trend: { verdict: outcome.verdict, growthPerCycle: outcome.growth, deltas: [] },
          };
        },
      }
    );
    return { report, seen, progress };
  }

  it("runs every measured server on the one binary given, and records its version", async () => {
    const { report, seen } = await run([NODE22], () => ({ verdict: "stable", growth: 0.1 * MB, heldMb: 48 }));

    expect(seen.map((entry) => entry.nodePath)).toEqual([NODE22.path]);
    expect(report.environment.nodeVersion).toBe("v22.23.5");
    expect(report.environment.comparedNodeVersions).toBeUndefined();
    const route = report.routes[0];
    expect(route?.status === "measured" && route.nodeVersions).toBeUndefined();
  });

  it("keeps next-leak's own Node when no binary is given", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    let nodePath: string | undefined = "unset";
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          nodePath = options.nodePath;
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );

    expect(nodePath).toBeUndefined();
    expect(report.environment.nodeVersion).toBe(process.version);
  });

  it("treats an empty list like no binary at all", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    let nodePath: string | undefined = "unset";
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", nodeBinaries: [] },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          nodePath = options.nodePath;
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );

    expect(nodePath).toBeUndefined();
  });

  it("measures once per binary, each in its own directory, and compares them", async () => {
    const { report, seen, progress } = await run([NODE22, NODE24], (nodePath) =>
      nodePath === NODE22.path
        ? { verdict: "stable", growth: 0.1 * MB, heldMb: 747 }
        : { verdict: "stable", growth: 0.1 * MB, heldMb: 48 }
    );

    expect(seen.map((entry) => entry.nodePath)).toEqual([NODE22.path, NODE24.path]);
    expect(seen[0]?.workDir.endsWith("-node1")).toBe(true);
    expect(seen[1]?.workDir.endsWith("-node2")).toBe(true);
    expect(progress.some((line) => line.includes("on Node v24.22.3"))).toBe(true);
    expect(report.environment.nodeVersion).toBe("v22.23.5");
    expect(report.environment.comparedNodeVersions).toEqual(["v22.23.5", "v24.22.3"]);
    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("expected a measured route");
    expect(route.nodeVersions).toEqual([
      { version: "v22.23.5", status: "measured", verdict: "stable", growthPer1000Requests: expect.any(Number), heldBytes: 747 * MB },
      { version: "v24.22.3", status: "measured", verdict: "stable", growthPer1000Requests: expect.any(Number), heldBytes: 48 * MB },
    ]);
  });

  it("gives each version the borderline confirmation a single run would", async () => {
    // Node 22 is a borderline leak and gets confirmed on Node 22; Node 24 is flat.
    const { seen, report } = await run([NODE22, NODE24], (nodePath) =>
      nodePath === NODE22.path
        ? { verdict: "leak", growth: 0.3 * MB, heldMb: 60 }
        : { verdict: "stable", growth: 0.1 * MB, heldMb: 48 }
    );

    expect(seen.map((entry) => entry.nodePath)).toEqual([NODE22.path, NODE22.path, NODE24.path]);
    expect(seen[1]?.workDir.endsWith("-node1-confirm")).toBe(true);
    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("expected a measured route");
    expect(route.nodeVersions?.map((entry) => entry.verdict)).toEqual(["leak", "stable"]);
  });

  it("stops comparing after an interrupt and keeps what ran", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const controller = new AbortController();
    const seen: Array<string | undefined> = [];
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", nodeBinaries: [NODE22, NODE24], signal: controller.signal },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          seen.push(options.nodePath);
          controller.abort();
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );
    const route = report.routes[0];

    expect(seen).toEqual([NODE22.path]);
    expect(route?.status === "measured" && route.nodeVersions?.map((entry) => entry.version)).toEqual([
      "v22.23.5",
    ]);
  });

  it("reports the first version's failure as the route's result", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", nodeBinaries: [NODE22, NODE24] },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          if (options.nodePath === NODE22.path) throw new Error("port race lost");
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );

    expect(report.routes[0]?.status).toBe("failed");
    // A failure carries no comparison: there is no headline result to set it beside.
    expect(report.routes[0] !== undefined && "nodeVersions" in report.routes[0]).toBe(false);
  });

  it("records a later version that did not measure", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", nodeBinaries: [NODE22, NODE24] },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          if (options.nodePath === NODE24.path) throw new Error("port race lost");
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );
    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("expected a measured route");

    expect(route.nodeVersions?.[1]).toEqual({ version: "v24.22.3", status: "failed" });
  });
});

// vercel/next.js#99983: `next dev` retains heap on every App Router render.
describe("measuring on next dev", () => {
  async function devApp(): Promise<string> {
    const appDir = await mkdtemp(path.join(tmpdir(), "next-leak-runner-dev-"));
    for (const file of ["app/page.jsx", "app/dynamic/page.jsx", "node_modules/next/dist/bin/next"]) {
      await mkdir(path.dirname(path.join(appDir, file)), { recursive: true });
      await writeFile(path.join(appDir, file), "");
    }
    return appDir;
  }

  it("leaves the cache alone: next dev persists nothing beside a build", async () => {
    const appDir = await devApp();
    // Where the standalone cleanup would look, relative to the server path.
    const wouldClean = path.join(appDir, "node_modules", "next", "dist", "bin", ".next", "server", "app");
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", dev: true },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          await mkdir(wouldClean, { recursive: true });
          await writeFile(path.join(wouldClean, `${options.route.replaceAll("/", "_")}.html`), "x");
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );

    expect((await readdir(wouldClean)).sort()).toEqual(["_.html", "_dynamic.html"]);
  });

  it("runs next dev for each route found in source, with no build", async () => {
    const appDir = await devApp();
    const seen: Array<{ route: string; serverPath: string; dev: unknown }> = [];
    let registryAsked = false;
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", dev: true },
      {
        ...makeDeps([]),
        registry: async () => {
          registryAsked = true;
          return new Map();
        },
        ritual: async (options) => {
          seen.push({ route: options.route, serverPath: options.serverPath, dev: options.dev });
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );

    expect(seen.map((entry) => entry.route)).toEqual(["/", "/dynamic"]);
    expect(seen[0]?.serverPath).toBe(path.join(appDir, "node_modules", "next", "dist", "bin", "next"));
    expect(seen[0]?.dev).toEqual({ appDir });
    expect(registryAsked).toBe(false);
    expect(report.server).toBe("dev");
    expect(report.prerender).toBeUndefined();
  });

  it("leaves a server run unmarked and on its standalone server", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    let dev: unknown = "unset";
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          dev = options.dev;
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );

    expect(dev).toBeUndefined();
    expect(report.server).toBeUndefined();
  });
});

// vercel/next.js#97938 slug route: four cycles read as a bend under pressure,
// sixteen showed a leak. A bending curve gets the longer look either way.
describe("re-measuring pressure promoted from a bending curve", () => {
  async function run(trend: { verdict: "pressure"; promotedFrom?: "stable" | "saturating" }) {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const cycles: Array<number | undefined> = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          cycles.push(options.cycles);
          const base = ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
          return { ...base, trend: { ...trend, growthPerCycle: 0.1 * MB, deltas: [] } };
        },
      }
    );
    return cycles;
  }

  it("measures it again with more cycles when the curve was saturating", async () => {
    const cycles = await run({ verdict: "pressure", promotedFrom: "saturating" });

    expect(cycles).toHaveLength(2);
    expect(cycles[1]).toBe(8);
  });

  it("leaves pressure over a flat curve at one pass", async () => {
    expect(await run({ verdict: "pressure", promotedFrom: "stable" })).toHaveLength(1);
    expect(await run({ verdict: "pressure" })).toHaveLength(1);
  });
});

describe("container memory limit", () => {
  async function messages(limit: number | null) {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const progress: string[] = [];
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (m) => progress.push(m) },
      { ...makeDeps([]), memoryLimit: () => limit }
    );
    return { progress, report };
  }

  it("warns before the first route when the limit cannot hold the cap", async () => {
    const { progress, report } = await messages(512 * MB);
    const warning = progress.findIndex((m) => m.startsWith("warning: memory limit 512 MB"));
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(report.environment.memoryLimitBytes).toBe(512 * MB);
  });

  it("stays quiet and records nothing without a limit", async () => {
    const { progress, report } = await messages(null);
    expect(progress.some((m) => m.includes("memory limit"))).toBe(false);
    expect(report.environment).not.toHaveProperty("memoryLimitBytes");
  });
});

describe("pacing notes during a run", () => {
  it("prices the re-measurement at the first pass's pace and the routes left", async () => {
    const appDir = await makeAppDir({ "/a/page": "app/a/page.js", "/b/page": "app/b/page.js" });
    let clockMs = 0;
    const progress: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (line) => progress.push(line) },
      {
        ...makeDeps([]),
        now: () => clockMs,
        ritual: async (ritualOptions) => {
          clockMs += 100_000;
          const base = ritualResult(ritualOptions.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
          return {
            ...base,
            // warm-up 2 s, 4 cycles of 50 s, after snapshot 18 s.
            timings: [
              { phase: "warm-up", seconds: 2 },
              ...[1, 2, 3, 4].map((cycle) => ({ phase: `cycle ${cycle} load`, seconds: 50 })),
              { phase: "after snapshot", seconds: 18 },
            ],
            trend: { verdict: "inconclusive" as const, growthPerCycle: 0, deltas: [] },
          };
        },
      }
    );

    // 20 s outside the cycles plus 8 cycles at 50 s.
    expect(progress).toContain(
      "re-measuring /a with 8 cycles: the first pass could not call it (≈ 7m at the pace of the first pass)"
    );
    // /a took two passes on the fake clock; one route left. 5000 requests in
    // 50 s is 100 req/s, under half of what the estimate assumed.
    expect(progress).toContain(
      "1 route left · ≈ 3m at the pace so far — /a served 100.0 req/s, not the 250 the estimate assumed"
    );
    expect(progress.filter((line) => line.includes("left ·"))).toHaveLength(1);
  });
});

// vercel/next.js#97938 slug route: about 1.3 MB of ISR render per unique key,
// 33 GB left in .next/standalone after five runs.
describe("cache entries the measured server writes", () => {
  it("removes each pass's renders before the next pass starts, and says so", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const cacheDir = path.join(appDir, ".next", "standalone", ".next", "server", "app");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, "index.html"), "built");
    const seenAtStart: string[][] = [];
    const progress: string[] = [];
    let call = 0;
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (line) => progress.push(line) },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          call += 1;
          seenAtStart.push((await readdir(cacheDir)).sort());
          await writeFile(path.join(cacheDir, `seed-${call}.html`), "x".repeat(2048));
          const base = ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
          // Undecided first, so a second pass follows.
          return call === 1
            ? { ...base, trend: { verdict: "inconclusive" as const, growthPerCycle: 0, deltas: [] } }
            : base;
        },
      }
    );

    expect(seenAtStart).toEqual([["index.html"], ["index.html"]]);
    expect(await readdir(cacheDir)).toEqual(["index.html"]);
    expect(progress.filter((line) => line.startsWith("removed 1 cache entry (0.0 MB)"))).toHaveLength(2);
  });

  it("cleans up after a process that failed", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const cacheDir = path.join(appDir, ".next", "standalone", ".next", "server", "app");
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js" },
      {
        ...makeDeps([]),
        ritual: async () => {
          await mkdir(cacheDir, { recursive: true });
          await writeFile(path.join(cacheDir, "seed-1.html"), "x");
          throw new Error("server crashed");
        },
      }
    );

    expect(await readdir(cacheDir).catch(() => "gone")).toBe("gone");
  });

  it("counts several entries in the plural", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const cacheDir = path.join(appDir, ".next", "standalone", ".next", "server", "app");
    const progress: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (line) => progress.push(line) },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          await mkdir(cacheDir, { recursive: true });
          await writeFile(path.join(cacheDir, "seed-1.html"), "x".repeat(1024 * 1024));
          await writeFile(path.join(cacheDir, "seed-1.meta"), "x".repeat(1024 * 1024));
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );
    expect(progress).toContain("removed 2 cache entries (2.0 MB) the server wrote next to the build");
  });

  it("keeps the measurement when the cleanup cannot run", async () => {
    // A cache directory the run cannot read: the listing fails up front.
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const nextDir = path.join(appDir, ".next", "standalone", ".next");
    await mkdir(nextDir, { recursive: true });
    // `server/app` is a link loop, which readdir reports as ELOOP.
    await mkdir(path.join(nextDir, "server"), { recursive: true });
    await symlink("app", path.join(nextDir, "server", "app"));
    const progress: string[] = [];
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (line) => progress.push(line) },
      makeDeps([])
    );

    expect(report.routes[0]?.status).toBe("measured");
    expect(progress.some((line) => line.startsWith("cannot list the build's cache, so it will not be cleaned: ELOOP"))).toBe(true);
  });

  it("keeps the measurement when the cleanup fails afterwards", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const serverDir = path.join(appDir, ".next", "standalone", ".next", "server");
    const progress: string[] = [];
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (line) => progress.push(line) },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          // Readable at the start; a link loop by the end.
          await mkdir(serverDir, { recursive: true });
          await symlink("app", path.join(serverDir, "app"));
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );

    expect(report.routes[0]?.status).toBe("measured");
    expect(progress.some((line) => line.startsWith("could not remove the cache entries the server wrote: ELOOP"))).toBe(true);
  });

  it("stays quiet when the server wrote nothing", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const progress: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (line) => progress.push(line) },
      makeDeps([])
    );
    expect(progress.some((line) => line.startsWith("removed"))).toBe(false);
  });
});

// vercel/next.js#97938 slug route: one route, four passes over two hours,
// killed during the last. Nothing had been written: run.json waited for the
// route to finish.
describe("saving progress within a route", () => {
  it("writes the best result so far before each further pass", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-checkpoint-"));
    const onDisk: Array<{ status: string; verdict?: string; incomplete?: boolean }> = [];
    let call = 0;
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          call += 1;
          if (call === 1) {
            // Nothing to save before the first repetition.
            const [stamp] = await readdir(outputDir);
            expect(await readdir(path.join(outputDir, stamp ?? ""))).not.toContain("run.json");
          }
          if (call > 1) {
            const [stamp] = await readdir(outputDir);
            const saved = JSON.parse(
              await readFile(path.join(outputDir, stamp ?? "", "run.json"), "utf8")
            ) as { routes: Array<{ status: string; trend?: { verdict: string }; incomplete?: boolean }> };
            const route = saved.routes[0];
            onDisk.push({
              status: route?.status ?? "missing",
              ...(route?.trend !== undefined && { verdict: route.trend.verdict }),
              ...(route?.incomplete === true && { incomplete: true }),
            });
          }
          const base = ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
          return {
            ...base,
            ...(call === 1 && {
              settleOutcomes: [{ phase: "cycle 1", status: "moving" as const, polls: 40 }],
            }),
            trend:
              call === 2
                ? { verdict: "leak" as const, growthPerCycle: 2.5 * MB, deltas: [] }
                : { verdict: "stable" as const, growthPerCycle: 0.1 * MB, deltas: [] },
          };
        },
      }
    );

    // Before the confirmation: the first pass. Before the settling pass: the
    // first pass with the disagreement attached.
    expect(onDisk).toEqual([
      { status: "measured", verdict: "stable", incomplete: true },
      { status: "measured", verdict: "stable", incomplete: true },
    ]);
    const [stamp] = await readdir(outputDir);
    const final = JSON.parse(await readFile(path.join(outputDir, stamp ?? "", "run.json"), "utf8")) as {
      routes: Array<{ incomplete?: boolean }>;
    };
    expect(final.routes[0]?.incomplete).toBeUndefined();
    expect((await readdir(path.join(outputDir, stamp ?? ""))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  // Run 3 of the series died during the first pass's diff, before the first
  // checkpoint, which only came before a second pass.
  it("saves the first pass before its snapshot diff starts", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-checkpoint-"));
    const base = makeDeps([]);
    let duringDiff: { status?: string; incomplete?: boolean; attributionGap?: { reason: string } } | undefined;
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir },
      {
        ...base,
        ritual: async () => ritualResult("/leaky", [29 * MB, 31 * MB, 33 * MB, 35 * MB]),
        diff: async (...args) => {
          const [stamp] = await readdir(outputDir);
          const saved = JSON.parse(
            await readFile(path.join(outputDir, stamp ?? "", "run.json"), "utf8")
          ) as { routes: Array<typeof duringDiff> };
          duringDiff = saved.routes[0];
          return base.diff(...args);
        },
      }
    );

    expect(duringDiff).toMatchObject({
      status: "measured",
      incomplete: true,
      attributionGap: { reason: "interrupted" },
    });
  });

  it("keeps measuring when a checkpoint cannot be written", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-checkpoint-"));
    const progress: string[] = [];
    let call = 0;
    const report = await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir, onProgress: (line) => progress.push(line) },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          call += 1;
          if (call === 1) {
            // run.json becomes a directory: the rename onto it fails.
            const [stamp] = await readdir(outputDir);
            await mkdir(path.join(outputDir, stamp ?? "", "run.json", "x"), { recursive: true });
          }
          const base = ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
          return {
            ...base,
            ...(call === 1 && {
              settleOutcomes: [{ phase: "cycle 1", status: "moving" as const, polls: 40 }],
            }),
          };
        },
      }
    ).catch((cause: unknown) => cause);

    expect(call).toBe(2);
    expect(progress.some((line) => line.startsWith("could not save progress to run.json:"))).toBe(true);
    // The final write fails the same way and is not swallowed.
    expect(report).toBeInstanceOf(Error);
  });
});

describe("an interrupt during a pass", () => {
  it("skips the snapshot diff and says the snapshots are on disk", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const controller = new AbortController();
    const events: string[] = [];
    const progress: string[] = [];
    const report = await runMeasurement(
      {
        appDir,
        bootstrapPath: "/fake/bootstrap.js",
        signal: controller.signal,
        onProgress: (line) => progress.push(line),
      },
      {
        ...makeDeps(events),
        ritual: async () => {
          // The interrupt lands while the leaking pass is running.
          controller.abort();
          return ritualResult("/leaky", [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );

    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("expected a measured route");
    expect(route.trend.verdict).toBe("leak");
    expect(events.some((event) => event.startsWith("diff:"))).toBe(false);
    expect(progress.some((line) => line.startsWith("diffing snapshots"))).toBe(false);
    expect(route.attributionGap).toEqual({
      reason: "interrupted",
      detail: "baseline /snap//leaky/baseline.heapsnapshot, after /snap//leaky/after.heapsnapshot",
    });
  });
});

describe("pacing around skipped routes", () => {
  it("prices only the routes that will run, at the pace of the ones that did", async () => {
    // /a, /c and /d run; /b/[slug] has no sample params and is skipped.
    const appDir = await makeAppDir({
      "/a/page": "app/a/page.js",
      "/b/[slug]/page": "app/b/[slug]/page.js",
      "/c/page": "app/c/page.js",
      "/d/page": "app/d/page.js",
    });
    let clockMs = 0;
    const progress: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", onProgress: (line) => progress.push(line) },
      {
        ...makeDeps([]),
        now: () => clockMs,
        ritual: async (options) => {
          clockMs += 120_000;
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );

    const notes = progress.filter((line) => line.includes("left ·"));
    // Two minutes a measured route. After /a two are left to run, not three;
    // the skip after it neither halves the pace nor gets its own note.
    expect(notes).toEqual([
      "2 routes left · ≈ 4m at the pace so far",
      "1 route left · ≈ 2m at the pace so far",
    ]);
  });
});

describe("saving progress across repetitions", () => {
  it("saves every repetition so far before the next one starts", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-checkpoint-"));
    const seen: Array<number | undefined> = [];
    let call = 0;
    let firstSawRunJson: boolean | undefined;
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir, repeat: 3 },
      {
        ...makeDeps([]),
        ritual: async (options) => {
          call += 1;
          if (call === 1) {
            // Nothing to save before the first repetition.
            const [stamp] = await readdir(outputDir);
            firstSawRunJson = (await readdir(path.join(outputDir, stamp ?? ""))).includes("run.json");
          }
          if (call > 1) {
            const [stamp] = await readdir(outputDir);
            const saved = JSON.parse(
              await readFile(path.join(outputDir, stamp ?? "", "run.json"), "utf8")
            ) as { routes: Array<{ repetitions?: unknown[]; incomplete?: boolean }> };
            seen.push(saved.routes[0]?.repetitions?.length);
          }
          return ritualResult(options.route, [29 * MB, 31 * MB, 33 * MB, 35 * MB]);
        },
      }
    );

    // Before the second repetition: one; before the third: two. No single
    // repetition's own save replaced them.
    expect(seen).toEqual([1, 2]);
    expect(firstSawRunJson).toBe(false);
  });
});

describe("a repetition's own pass", () => {
  it("does not replace the repetitions already saved", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-checkpoint-"));
    const duringDiffs: Array<number | undefined> = [];
    const base = makeDeps([]);
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir, repeat: 2 },
      {
        ...base,
        // A leak, so each repetition reaches its diff.
        ritual: async () => ritualResult("/leaky", [29 * MB, 31 * MB, 33 * MB, 35 * MB]),
        diff: async (...args) => {
          const [stamp] = await readdir(outputDir);
          const file = path.join(outputDir, stamp ?? "", "run.json");
          const saved = await readFile(file, "utf8").catch(() => null);
          const parsed = saved === null ? null : (JSON.parse(saved) as { routes: Array<{ repetitions?: unknown[] }> });
          duringDiffs.push(parsed?.routes[0]?.repetitions?.length);
          return base.diff(...args);
        },
      }
    );

    // First repetition's diff: nothing saved yet. Second's: the aggregate of one.
    expect(duringDiffs).toEqual([undefined, 1]);
  });
});
