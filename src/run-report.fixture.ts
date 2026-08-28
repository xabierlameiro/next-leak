import type { RunReport } from "./runner.js";

const MB = 1024 * 1024;

/** Canonical report fixture shared by report/html/issue renderer tests. */

/** Phase bookkeeping shared by every healthy fixture route. */
const cleanPhases = () => ({
  rssPer1000Requests: 0,
  timings: [{ phase: "warm-up", seconds: 1.2 }],
  loadOutcomes: [{ phase: "cycle 1", sent: 5000, ok2xx: 5000 }],
  settleOutcomes: [{ phase: "cycle 1", status: "settled" as const, polls: 2 }],
  confidence: { level: "high" as const, warnings: [] },
  // Proportionate to what these routes retain: no peak note.
  peaks: [
    {
      phase: "cycle 1",
      heapUsed: 60 * MB,
      external: 2 * MB,
      arrayBuffers: 1 * MB,
      rss: 180 * MB,
      polls: 40,
    },
  ],
  requestsPerCycle: 5000,
  // Flat before collection as well as after it: no unreclaimed note.
  unreclaimedSamples: [40.1, 40.4, 40.2, 40.3].map((mb) => ({
    gcExposed: true,
    heapUsed: mb * MB,
    rss: 190 * MB,
    external: 2 * MB,
    arrayBuffers: 1 * MB,
  })),
  unreclaimedTrend: {
    verdict: "stable" as const,
    growthPerCycle: 0.05 * MB,
    deltas: [-0.2 * MB, 0.1 * MB],
  },
});

export function makeRunReport(): RunReport {
  return {
    appDir: "/apps/shop",
    startedAt: "2026-07-20T12:00:00.000Z",
    workDir: "/apps/shop/.next-leak/2026-07-20T12-00-00-000Z",
    harness: { verified: false },
    environment: {
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "arm64",
      cpuModel: "Apple M3",
      totalMemoryBytes: 32 * 1024 * MB,
      nextVersion: "16.0.1",
      nextLeakVersion: "0.0.0",
    },
    parameters: {
      warmupRequests: 200,
      loadRequests: 5000,
      connections: 100,
      cycles: 4,
      idleMs: 30_000,
      maxOldSpaceMb: 512,
      minGrowthPerCycle: 256 * 1024,
    },
    bundle: {
      htmlReport: "/apps/shop/.next-leak/2026-07-20T12-00-00-000Z/report.html",
      issues: [
        {
          route: "/leaky",
          file: "/apps/shop/.next-leak/2026-07-20T12-00-00-000Z/ISSUE-leaky.md",
        },
      ],
    },
    routes: [
      {
        route: "/",
        status: "measured",
        requestPath: "/",
        samples: [29.4 * MB, 31.5 * MB, 32.3 * MB, 32.1 * MB],
        memorySamples: [29.4, 31.5, 32.3, 32.1].map((mb) => ({ gcExposed: true, heapUsed: mb * MB, rss: 120 * MB, external: 1, arrayBuffers: 1 })),
        ...cleanPhases(),
        trend: { verdict: "stable", growthPerCycle: 0.3 * MB, deltas: [0.8 * MB, -0.2 * MB] },
        growthPer1000Requests: 0.06 * MB,
        baselineSnapshot: "/x/baseline.heapsnapshot",
        afterSnapshot: "/x/after.heapsnapshot",
        diff: null,
        attribution: null,
        signatures: [],
      },
      {
        route: "/leaky",
        status: "measured",
        requestPath: "/leaky",
        samples: [29.1 * MB, 30.5 * MB, 33.6 * MB, 35.9 * MB],
        memorySamples: [29.1, 30.5, 33.6, 35.9].map((mb) => ({ gcExposed: true, heapUsed: mb * MB, rss: 140 * MB, external: 1, arrayBuffers: 1 })),
        ...cleanPhases(),
        trend: { verdict: "leak", growthPerCycle: 2.7 * MB, deltas: [3.1 * MB, 2.3 * MB] },
        growthPer1000Requests: 0.54 * MB,
        baselineSnapshot: "/x/leaky/baseline.heapsnapshot",
        afterSnapshot: "/x/leaky/after.heapsnapshot",
        diff: {
          typeDeltas: [{ type: "concatenated string", deltaBytes: 1.37 * MB }],
          grownNodes: [
            {
              kind: "grown",
              nodeType: "object",
              name: "Array",
              retainedBytes: 1.65 * MB,
              retainerChain: "system / Context#object[.d] <- e#closure[.context]",
              moduleIds: [35194],
            },
          ],
          newNodes: [],
        },
        attribution: {
          findings: [{ owner: "app", source: "src/app/leaky/page.tsx", packageName: null }],
          route: {
            owner: "app",
            source: "src/app/leaky/page.tsx",
            packageName: null,
            dominance: 1,
          },
        },
        signatures: [
          {
            id: "test",
            title: "fetch retention",
            cause: "because",
            issue: "https://github.com/vercel/next.js/issues/90433",
            historical: true,
          },
        ],
      },
      { route: "/products/[id]", status: "skipped", reason: "needs sample params" },
      { route: "/broken", status: "failed", reason: "route exploded under load" },
    ],
  };
}
