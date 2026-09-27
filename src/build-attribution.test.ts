import { describe, expect, it, vi } from "vitest";
import {
  attributeBuildCapture,
  isAttributionGap,
  type BuildAttribution,
  type BuildAttributionDeps,
  type BuildAttributionGap,
} from "./build-attribution.js";
import type { BuildRunResult } from "./build-run.js";
import { SnapshotError, type HeapDiff } from "./heap-diff.js";

const MB = 1024 * 1024;

const emptyDiff: HeapDiff = {
  grownNodes: [],
  newNodes: [],
  typeDeltas: [],
};

const measured = (
  capture: BuildRunResult["capture"],
  captureRequested = true,
  captureFailure: string | null = null
): BuildRunResult => ({
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
  captureRequested,
  captureFailure,
  strippedCapWarning: null,
  exitCode: 1,
  output: "",
});

const capture: NonNullable<BuildRunResult["capture"]> = {
  pid: 500,
  files: { baselineFile: "/run/a.heapsnapshot", afterFile: "/run/b.heapsnapshot" },
  baselineRssBytes: 200 * MB,
  afterRssBytes: 1000 * MB,
  peakRssBytes: 3400 * MB,
};

/** Reads the fields of a successful attribution, failing loudly on a gap. */
const attributed = (
  outcome: BuildAttribution | BuildAttributionGap | null
): BuildAttribution => {
  if (outcome === null || isAttributionGap(outcome)) {
    throw new Error(`expected an attribution, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
};

const deps = (overrides: Partial<BuildAttributionDeps> = {}): BuildAttributionDeps => ({
  diff: vi.fn(async () => emptyDiff),
  registry: vi.fn(async () => new Map([[1, "app/page.tsx"]])),
  ...overrides,
});

describe("attributeBuildCapture", () => {
  // Nobody asked what the worker retained, so there is nothing to report and
  // nothing to apologise for.
  it("returns nothing when the run never asked to capture", async () => {
    expect(
      await attributeBuildCapture(measured(null, false), "/apps/docs", () => {}, deps())
    ).toBeNull();
  });

  // Asked and missed is a finding. Reporting it as silence lets a lost
  // measurement read exactly like a build with nothing to name.
  it("reports the gap when capture was asked for and came back empty", async () => {
    const result = await attributeBuildCapture(
      measured(null, true, "worker 500 never grew enough to snapshot"),
      "/apps/docs",
      () => {},
      deps()
    );

    expect(result).toEqual({
      reason: "capture-missed",
      detail: "worker 500 never grew enough to snapshot",
    });
  });

  // The verdict and curve stand on their own. An addition that can fail must
  // not be able to take the report down with it.
  it("degrades to a gap when the snapshot cannot be parsed", async () => {
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

    expect(result).toEqual({
      reason: "snapshot-unreadable",
      detail: "heap snapshot is 2388 MB, past the 512 MB a string can hold",
    });
    expect(messages.join("\n")).toContain("past the 512 MB");
  });

  it("degrades to a gap when the diff throws for any other reason", async () => {
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

    expect(result).toEqual({
      reason: "snapshot-unreadable",
      detail: "the snapshot pair could not be diffed",
    });
  });

  it("reports how much of the observed growth the pair spans", async () => {
    const result = await attributeBuildCapture(measured(capture), "/apps/docs", () => {}, deps());

    // 200 MB to 1000 MB out of a 3400 MB peak: a quarter of the growth.
    expect(attributed(result).bracketed).toBeCloseTo(0.25, 2);
  });

  // On a multi-worker build the highest peak can belong to a worker nothing
  // was captured from, and quoting the share against it would describe a curve
  // these findings say nothing about.
  it("quotes the share against the captured worker, not the loudest one", async () => {
    const result = measured({ ...capture, peakRssBytes: 1000 * MB });
    // Another worker of the same build reached far higher.
    result.peakWorkerRssBytes = 9000 * MB;

    const attribution = await attributeBuildCapture(result, "/apps/docs", () => {}, deps());

    // 200 MB to 1000 MB of a worker that peaked at 1000 MB: all of its growth.
    expect(attributed(attribution).bracketed).toBe(1);
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

    expect(attributed(result).registrySize).toBe(0);
    expect(attributed(result).attributed.route.owner).toBe("unattributed");
  });
});
