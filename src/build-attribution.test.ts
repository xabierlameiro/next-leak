import { describe, expect, it, vi } from "vitest";
import { attributeBuildCapture, type BuildAttributionDeps } from "./build-attribution.js";
import type { BuildRunResult } from "./build-run.js";
import { SnapshotError, type HeapDiff } from "./heap-diff.js";

const MB = 1024 * 1024;

const emptyDiff: HeapDiff = {
  grownNodes: [],
  newNodes: [],
  typeDeltas: [],
};

const measured = (capture: BuildRunResult["capture"]): BuildRunResult => ({
  appDir: "/apps/docs",
  status: "measured",
  samplingFailure: null,
  verdict: "leak",
  trend: { verdict: "leak", growthPerCycle: 315 * MB, deltas: [], source: "heap" },
  levels: [],
  workers: [{ pid: 500, samples: [] }],
  parentSamples: [],
  peakWorkerRssBytes: 3400 * MB,
  netGrowthBytes: 0,
  pagesGenerated: null,
  retentionPerPageBytes: null,
  heapExhausted: true,
  capture,
  strippedCapWarning: null,
  exitCode: 1,
  output: "",
});

const capture: NonNullable<BuildRunResult["capture"]> = {
  pid: 500,
  files: { baselineFile: "/run/a.heapsnapshot", afterFile: "/run/b.heapsnapshot" },
  baselineRssBytes: 200 * MB,
  afterRssBytes: 1000 * MB,
};

const deps = (overrides: Partial<BuildAttributionDeps> = {}): BuildAttributionDeps => ({
  diff: vi.fn(async () => emptyDiff),
  registry: vi.fn(async () => new Map([[1, "app/page.tsx"]])),
  ...overrides,
});

describe("attributeBuildCapture", () => {
  it("returns nothing when the run captured no pair", async () => {
    expect(await attributeBuildCapture(measured(null), "/apps/docs", () => {}, deps())).toBeNull();
  });

  // The verdict and curve stand on their own. An addition that can fail must
  // not be able to take the report down with it.
  it("degrades to nothing when the snapshot cannot be parsed", async () => {
    const messages: string[] = [];
    const result = await attributeBuildCapture(
      measured(capture),
      "/apps/docs",
      (message) => messages.push(message),
      deps({
        diff: vi.fn(async () => {
          throw new SnapshotError("heap snapshot is 2388 MB, past the 512 MB a string can hold");
        }),
      })
    );

    expect(result).toBeNull();
    expect(messages.join("\n")).toContain("past the 512 MB");
  });

  it("degrades to nothing when the diff throws for any other reason", async () => {
    const result = await attributeBuildCapture(
      measured(capture),
      "/apps/docs",
      () => {},
      deps({
        diff: vi.fn(async () => {
          throw new Error("boom");
        }),
      })
    );

    expect(result).toBeNull();
  });

  it("reports how much of the observed growth the pair spans", async () => {
    const result = await attributeBuildCapture(measured(capture), "/apps/docs", () => {}, deps());

    // 200 MB to 1000 MB out of a 3400 MB peak: a quarter of the growth.
    expect(result?.bracketed).toBeCloseTo(0.25, 2);
  });

  it("reads the registry from the finished build, never mid-flight", async () => {
    const registry = vi.fn(async () => new Map<number, string>());
    await attributeBuildCapture(measured(capture), "/apps/docs", () => {}, deps({ registry }));

    expect(registry).toHaveBeenCalledWith("/apps/docs/.next/server");
  });

  it("keeps going with an empty registry rather than guessing an owner", async () => {
    const result = await attributeBuildCapture(
      measured(capture),
      "/apps/docs",
      () => {},
      deps({ registry: vi.fn(async () => new Map<number, string>()) })
    );

    expect(result).not.toBeNull();
    expect(result?.registrySize).toBe(0);
    expect(result?.attributed.route.owner).toBe("unattributed");
  });
});
