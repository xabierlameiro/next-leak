import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMeasurement } from "./runner.js";

// Full pipeline, nothing faked: real child process with --expose-gc, real
// autocannon load, real heap snapshots, real memlab diff. The fixture app has
// the standalone layout with a healthy route and the phase-0 leaky pattern
// (module-level array retaining ~8 KB per request).
const rootDir = fileURLToPath(new URL("..", import.meta.url));
const appDir = fileURLToPath(new URL("./__fixtures__/e2e-app", import.meta.url));

describe("next-leak end to end", () => {
  it("tells the leaky route apart from the healthy one and keeps the evidence", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-e2e-"));
    const report = await runMeasurement({
      appDir,
      bootstrapPath: path.join(rootDir, "dist", "bootstrap.js"),
      outputDir,
      warmupRequests: 50,
      loadRequests: 300,
      connections: 10,
      cycles: 3,
      idleMs: 300,
      routeFilter: ["/", "/leaky"],
    });

    const byRoute = new Map(report.routes.map((route) => [route.route, route]));
    const healthy = byRoute.get("/");
    const leaky = byRoute.get("/leaky");
    if (healthy?.status !== "measured" || leaky?.status !== "measured") {
      throw new Error(`both routes should be measured: ${JSON.stringify(report.routes)}`);
    }

    // The verdicts must differ in the right direction.
    expect(leaky.trend.verdict).toBe("leak");
    expect(healthy.trend.verdict).not.toBe("leak");
    // ~8 KB × 300 req ≈ 2.4 MB per cycle, well above noise.
    expect(leaky.trend.growthPerCycle).toBeGreaterThan(1024 * 1024);

    // The diff ran on real snapshots and found real growth.
    expect(leaky.diff).not.toBeNull();
    const findings = [...(leaky.diff?.grownNodes ?? []), ...(leaky.diff?.newNodes ?? [])];
    expect(findings.length).toBeGreaterThan(0);

    // The fixture is not a bundler build: no registry, so attribution must
    // degrade to null/none without breaking the run (spec: nothing resolvable).
    expect(leaky.attribution).toBeNull();
    expect(leaky.signatures).toEqual([]);

    // The evidence survives: snapshots on disk, run.json persisted.
    for (const file of [
      leaky.baselineSnapshot,
      leaky.afterSnapshot,
      path.join(report.workDir, "run.json"),
    ]) {
      expect((await stat(file)).size).toBeGreaterThan(0);
    }

    // The evidence bundle: offline HTML with both curves, one issue draft.
    const html = await readFile(report.bundle.htmlReport, "utf8");
    expect((html.match(/<svg /g) ?? [])).toHaveLength(2);
    expect(html).not.toMatch(/<script[\s>]/);
    expect(report.bundle.issues.map((issue) => issue.route)).toEqual(["/leaky"]);
    const issueFile = report.bundle.issues[0]?.file ?? "";
    const markdown = await readFile(issueFile, "utf8");
    expect(markdown).toContain("# Memory leak on route `/leaky`");
    expect(markdown).toContain("### To Reproduce");
    expect(markdown).toContain("warm-up 50 requests");
    expect(markdown).toContain("3 × [300 requests at 10 connections");
  }, 180_000);
});

// The fixture's /cached route is a bounded store on an exponential approach to
// its capacity: it grows every cycle, by 40% of the previous cycle each time.
// That clears `allGrow`, so before saturation detection the whole pipeline
// called it a leak — the same mistake a `use cache` route drew out of a real
// run on Next 16.3.3.
describe("a filling cache is not a leak", () => {
  it("reports decelerating growth as saturating, and still calls the leaky route a leak", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "next-leak-e2e-cache-"));
    const report = await runMeasurement({
      appDir,
      bootstrapPath: path.join(rootDir, "dist", "bootstrap.js"),
      outputDir,
      warmupRequests: 50,
      loadRequests: 300,
      connections: 10,
      // Four cycles leave three post-warm-up deltas, the minimum a bend needs.
      cycles: 4,
      idleMs: 300,
      routeFilter: ["/cached", "/leaky"],
      // The second pass would double an already slow e2e; the shape is the
      // point here, and it is settled on the first.
      resolveInconclusive: false,
    });

    const byRoute = new Map(report.routes.map((route) => [route.route, route]));
    const cached = byRoute.get("/cached");
    const leaky = byRoute.get("/leaky");
    if (cached?.status !== "measured" || leaky?.status !== "measured") {
      throw new Error(`both routes should be measured: ${JSON.stringify(report.routes)}`);
    }

    expect(cached.trend.verdict).toBe("saturating");
    // Not a quiet verdict: it grew, and by enough to have been called a leak.
    expect(cached.trend.growthPerCycle).toBeGreaterThan(256 * 1024);
    // The control: real retention is still reported as what it is.
    expect(leaky.trend.verdict).toBe("leak");
  }, 240_000);
});
