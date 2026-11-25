import { describe, expect, it } from "vitest";
import { formatBuildReport } from "./build-report.js";
import type { BuildRunResult } from "./build-run.js";

const MB = 1024 * 1024;

const baseResult: BuildRunResult = {
  appDir: "/apps/docs",
  status: "measured",
  samplingFailure: null,
  verdict: "leak",
  trend: { verdict: "leak", growthPerCycle: 315 * MB, deltas: [], source: "heap" },
  levels: [1070, 1400, 1930, 2380, 2700, 2960].map((value) => value * MB),
  workers: [{ pid: 97155, samples: [] }],
  parentSamples: [],
  treeSamples: [],
  peakWorkerRssBytes: 2960 * MB,
  netGrowthBytes: 1560 * MB,
  pagesGenerated: 1700,
  retentionPerPageBytes: 0.97 * MB,
  heapExhausted: true,
  capture: null,
  captureRequested: false,
  captureFailure: null,
  strippedCapWarning: null,
  warmCacheWarning: null,
  exitCode: 1,
  output: "",
};

describe("formatBuildReport", () => {
  it("leads with the verdict and the curve it came from", () => {
    const output = formatBuildReport(baseResult);

    expect(output).toContain("static-generation worker  leak");
    expect(output).toContain("worker rss 1070.0 MB → 1400.0 MB");
  });

  it("states retention per page, which is the number that predicts a bigger site", () => {
    expect(formatBuildReport(baseResult)).toContain("0.97 MB/page over 1700 pages");
  });

  it("omits the per-page figure rather than inventing a denominator", () => {
    const output = formatBuildReport({
      ...baseResult,
      pagesGenerated: null,
      retentionPerPageBytes: null,
    });

    expect(output).toContain("grew 1560.0 MB");
    expect(output).not.toContain("/page");
  });

  it("reports heap exhaustion as the finding, with what it reached", () => {
    const output = formatBuildReport(baseResult);

    expect(output).toContain("ran out of heap");
    expect(output).toContain("2960.0 MB");
    expect(output).toContain("1700 pages");
    expect(output).toContain("no per-page figure for a crashed build");
    expect(output).toContain("raising the cap moves the wall");
  });

  it("calls the memory resident, never retained heap", () => {
    // No forced collection stands behind these samples, so the wording must
    // not borrow the precision the runtime numbers have.
    const output = formatBuildReport(baseResult);

    expect(output).toContain("worker rss");
    expect(output).not.toContain("retained heap");
  });

  it("makes no memory claim when the build failed for another reason", () => {
    const output = formatBuildReport({
      ...baseResult,
      status: "build-failed",
      verdict: null,
      trend: null,
      levels: [],
      heapExhausted: false,
  capture: null,
      output: "Type error: Property 'x' does not exist",
    });

    expect(output).toContain("not memory");
    expect(output).toContain("no memory claim is made");
    expect(output).toContain("Type error");
    expect(output).not.toContain("worker  leak");
    expect(output).not.toContain("worker rss");
  });

  it("says plainly when there was nothing to measure", () => {
    const output = formatBuildReport({
      ...baseResult,
      status: "nothing-to-measure",
      verdict: null,
      levels: [],
      workers: [],
    });

    expect(output).toContain("no static-generation worker ran");
  });

  it("does not let a short build read as healthy", () => {
    const output = formatBuildReport({
      ...baseResult,
      verdict: "inconclusive",
      levels: [],
      netGrowthBytes: 0,
      heapExhausted: false,
    });

    expect(output).toContain("too short to judge");
    expect(output).toContain("not a sign of health");
  });

  it("surfaces the stripped heap cap above everything else", () => {
    const output = formatBuildReport({
      ...baseResult,
      strippedCapWarning: "NODE_OPTIONS sets --max-old-space-size=2048, which Next strips",
      });

    expect(output.split("\n").slice(0, 4).join("\n")).toContain("Next strips");
  });

  it("says how many workers ran when more than one did", () => {
    const output = formatBuildReport({
      ...baseResult,
      workers: [
        { pid: 1, samples: [] },
        { pid: 2, samples: [] },
      ],
    });

    expect(output).toContain("2 workers ran");
    expect(output).toContain("worst of them");
  });
});

// An unreadable process table and a build with no workers look identical from
// the sampler's side, and only one of them is good news.
describe("formatBuildReport when the table cannot be read", () => {
  it("says it could not look, not that there was nothing to see", () => {
    const output = formatBuildReport({
      ...baseResult,
      status: "cannot-sample",
      samplingFailure: "spawn ps EPERM",
      verdict: null,
      trend: null,
      levels: [],
      workers: [],
    });

    expect(output).toContain("could not read the process table");
    expect(output).toContain("spawn ps EPERM");
    expect(output).toContain("not a clean run");
    expect(output).not.toContain("nothing to measure");
  });
});

// The bracketed share is the load-bearing number here: the parse limit keeps
// both snapshots low, so the findings explain a minority of the curve and the
// report must not let a reader assume otherwise.
describe("formatBuildReport attribution", () => {
  const attribution = {
    diff: {
      grownNodes: [
        {
          name: "IncrementalCache",
          retainedBytes: 180 * MB,
          retainerChain: "Object[.cache] <- Module[.exports]",
          moduleIds: [1],
        },
      ],
      newNodes: [],
      typeDeltas: [],
    },
    attributed: {
      findings: [{ owner: "framework" as const, source: null, packageName: "next" }],
      route: {
        owner: "framework" as const,
        source: null,
        packageName: "next",
        dominance: 1,
      },
    },
    registrySize: 198,
    bracketed: 0.25,
    baselineRssBytes: 200 * MB,
    afterRssBytes: 1000 * MB,
    baselineFile: "/run/worker-500-baseline.heapsnapshot",
    afterFile: "/run/worker-500-after.heapsnapshot",
  };

  it("says what was retained, and over how much of the curve", () => {
    const output = formatBuildReport(baseResult, attribution as never);

    expect(output).toContain("IncrementalCache");
    expect(output).toContain("25% of the growth");
    expect(output).toContain("200.0 MB");
  });

  it("says when no owner could be resolved instead of naming one", () => {
    const output = formatBuildReport(
      baseResult,
      {
        ...attribution,
        registrySize: 0,
        attributed: {
          findings: [{ owner: "unattributed" as const, source: null, packageName: null }],
          route: {
            owner: "unattributed" as const,
            source: null,
            packageName: null,
            dominance: 0,
          },
        },
      } as never
    );

    expect(output).toContain("no module registry resolved");
    expect(output).toContain("unattributed");
  });

  it("is silent when there is no attribution at all", () => {
    const output = formatBuildReport(baseResult);

    expect(output).not.toContain("what it retained");
    expect(output).not.toContain("no attribution");
  });

  // The build path loses attribution hardest on the builds worth measuring: a
  // snapshot past roughly a gigabyte of worker rss cannot be read back. Silence
  // there reads as "nothing grew", which is the opposite of what was found.
  it("says a requested attribution went missing instead of omitting the section", () => {
    const output = formatBuildReport(baseResult, {
      reason: "snapshot-unreadable",
      detail: "heap snapshot is 2388 MB, past the 512 MB a string can hold",
    });

    expect(output).toContain("no attribution: heap snapshot is 2388 MB");
    expect(output).toContain("This does not say nothing grew");
  });

  it("names how far capture got when it was asked for and missed", () => {
    const output = formatBuildReport(baseResult, {
      reason: "capture-missed",
      detail: "worker 97155 was snapshotted once and never reached a second point",
    });

    expect(output).toContain("never reached a second point");
  });
});

// The parent was sampled and discarded for two releases while the type called
// it "reported". Two open issues fail entirely in it: vercel/next.js#97802 dies
// in compilation before a worker exists, and #76704 fails in the file-tracing
// phase that runs after static generation.
describe("the build's own process", () => {
  const withParent = (rss: number[]): BuildRunResult => ({
    ...baseResult,
    parentSamples: rss.map((value, index) => ({ atMs: index * 1000, rssBytes: value * MB })),
  });

  it("reports what the parent reached and where it ended", () => {
    const output = formatBuildReport(withParent([200, 1430, 980, 100]));

    expect(output).toContain("peaked at 1430.0 MB");
    expect(output).toContain("ended at 100.0 MB");
  });

  // The parent shedding while the worker climbs is the reason the two are never
  // added together; the report has to say so or the reader will add them.
  it("says the parent figure is reported and not judged", () => {
    const output = formatBuildReport(withParent([200, 1430, 100]));

    expect(output).toContain("reported, not judged");
    expect(output).toContain("never added to the figure above");
  });

  it("says nothing when the parent was never sampled", () => {
    const output = formatBuildReport(withParent([]));

    expect(output).not.toContain("the build's own process");
  });

  it("leaves the worker verdict untouched", () => {
    const output = formatBuildReport(withParent([200, 1430, 100]));

    expect(output).toContain("static-generation worker  leak");
    expect(output).toContain("peak worker rss 2960.0 MB");
  });
});

// vercel/next.js#100064 on 16.4.0, 2026-11-25: 104 Turbopack pool processes
// and 7.56 GiB across the tree while the workers peaked at 115.9 MB, and the
// report said only that the build was too short to judge.
describe("the whole build tree", () => {
  const tree = (
    points: ReadonlyArray<readonly [number, number, number, number]>
  ): BuildRunResult["treeSamples"] =>
    points.map(([rss, processes, pools, poolRss], index) => ({
      atMs: index * 500,
      rssBytes: rss * MB,
      processes,
      poolProcesses: pools,
      poolRssBytes: poolRss * MB,
    }));

  it("reports the tree peak and the pools behind it", () => {
    const output = formatBuildReport({
      ...baseResult,
      treeSamples: tree([
        [1500, 4, 0, 0],
        [7741, 108, 104, 6175],
        [1400, 5, 2, 120],
      ]),
    });

    expect(output).toContain("whole build tree peaked at 7741.0 MB across 108 processes");
    expect(output).toContain("up to 104 of them were Turbopack Node.js pools");
    expect(output).toContain("holding 6175.0 MB between them");
    expect(output).toContain("reported, not judged");
  });

  it("names the poll with the most pools, which need not be the tree peak", () => {
    const output = formatBuildReport({
      ...baseResult,
      treeSamples: tree([
        [3000, 60, 57, 3300],
        [3500, 6, 2, 100],
      ]),
    });

    expect(output).toContain("peaked at 3500.0 MB across 6 processes");
    expect(output).toContain("up to 57 of them");
  });

  it("does not mention pools on a build that started none", () => {
    const output = formatBuildReport({ ...baseResult, treeSamples: tree([[1500, 4, 0, 0]]) });

    expect(output).toContain("whole build tree peaked at 1500.0 MB");
    expect(output).not.toContain("Turbopack");
  });

  it("says nothing when the tree was never sampled", () => {
    expect(formatBuildReport(baseResult)).not.toContain("whole build tree");
  });

  it("reports the tree on a failed build and on one with no worker", () => {
    const samples = tree([[4880, 60, 57, 3370]]);
    const failed = formatBuildReport({
      ...baseResult,
      status: "build-failed",
      treeSamples: samples,
    });
    const empty = formatBuildReport({
      ...baseResult,
      status: "nothing-to-measure",
      treeSamples: samples,
    });

    expect(failed).toContain("up to 57 of them were Turbopack Node.js pools");
    expect(empty).toContain("up to 57 of them were Turbopack Node.js pools");
  });

  it("leaves the worker verdict untouched", () => {
    const output = formatBuildReport({
      ...baseResult,
      treeSamples: tree([[7741, 108, 104, 6175]]),
    });

    expect(output).toContain("static-generation worker  leak");
    expect(output).toContain("peak worker rss 2960.0 MB");
  });
});

describe("a build Next stopped for a security upgrade", () => {
  const stopped: BuildRunResult = {
    ...baseResult,
    status: "build-failed",
    exitCode: 1,
    output:
      "> Build error occurred\nError [SecurityFatalError]: Your version of Next.js is affected by a known security vulnerability.\n",
  };

  it("explains the stop and how to get past it", () => {
    const output = formatBuildReport(stopped);

    expect(output).toContain("failed for a reason that is not memory");
    expect(output).toContain("Next stopped the build to recommend a security upgrade");
    expect(output).toContain("when it detects an AI agent");
    expect(output).toContain("next-agentic-upgrade-retries");
    expect(output).toContain("re-run without deleting");
  });

  it("says nothing about it on any other failure", () => {
    const output = formatBuildReport({ ...stopped, output: "Type error: x is not assignable" });

    expect(output).not.toContain("security upgrade");
  });
});

describe("a warm compiler cache", () => {
  const warning =
    ".next/cache/turbopack holds a compiler cache from an earlier build, so compilation may be served from it rather than measured. Delete .next/cache/turbopack (not the rest of .next/cache) for a cold build";

  it("leads the report, before the verdict", () => {
    const output = formatBuildReport({ ...baseResult, warmCacheWarning: warning });

    expect(output).toContain(`▲ ${warning}`);
    expect(output.indexOf(warning)).toBeLessThan(output.indexOf("static-generation worker"));
  });

  it("is reported on a failed build as well", () => {
    const output = formatBuildReport({
      ...baseResult,
      status: "build-failed",
      warmCacheWarning: warning,
    });

    expect(output).toContain(warning);
  });

  it("is absent when the build compiled cold", () => {
    expect(formatBuildReport(baseResult)).not.toContain("compiler cache");
  });
});
