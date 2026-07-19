import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RitualResult } from "./ritual.js";
import {
  estimateRunSeconds,
  formatDuration,
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
    samples,
    memorySamples: samples.map((heapUsed) => ({
      gcExposed: true,
      heapUsed,
      rss: 3 * heapUsed,
      external: 0,
      arrayBuffers: 0,
    })),
    baselineSnapshot: `/snap/${route}/baseline.heapsnapshot`,
    afterSnapshot: `/snap/${route}/after.heapsnapshot`,
    trend: {
      verdict: route === "/leaky" ? "leak" : "stable",
      growthPerCycle: route === "/leaky" ? 2.5 * MB : 0.1 * MB,
      deltas: [],
    },
    requestsPerCycle: 5000,
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

describe("estimateRunSeconds", () => {
  const parameters = {
    warmupRequests: 200,
    loadRequests: 5000,
    connections: 100,
    cycles: 3,
    idleMs: 30_000,
  };

  it("puts a 60-route default run in the hours range (the first-user wall)", () => {
    const seconds = estimateRunSeconds(60, parameters);
    expect(seconds).toBeGreaterThan(2 * 3600);
    expect(formatDuration(seconds)).toMatch(/h$/);
  });

  it("keeps small scoped runs in minutes", () => {
    const seconds = estimateRunSeconds(3, { ...parameters, loadRequests: 300, idleMs: 5000 });
    expect(seconds).toBeLessThan(15 * 60);
    expect(formatDuration(90)).toBe("2m");
    expect(formatDuration(45)).toBe("45s");
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

  it("prints route count and duration estimate before measuring", async () => {
    const appDir = await makeAppDir({ "/page": "app/page.js" });
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-out-"));
    const progress: string[] = [];
    await runMeasurement(
      { appDir, bootstrapPath: "/fake/bootstrap.js", outputDir, onProgress: (m) => progress.push(m) },
      makeDeps([])
    );
    expect(progress.some((message) => /1 routes discovered · estimated ≈/.test(message))).toBe(true);
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

    const html = await readFile(report.bundle.htmlReport, "utf8");
    expect(html).toContain("next-leak report");
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
