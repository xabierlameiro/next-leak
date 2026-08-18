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
  peakWorkerRssBytes: 2960 * MB,
  netGrowthBytes: 1560 * MB,
  pagesGenerated: 1700,
  retentionPerPageBytes: 0.97 * MB,
  heapExhausted: true,
  strippedCapWarning: null,
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
