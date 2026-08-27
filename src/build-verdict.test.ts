import { describe, expect, it } from "vitest";
import {
  BUILD_SEGMENTS,
  classifyBuildSamples,
  diedOfHeapExhaustion,
  netGrowthOf,
  pagesGeneratedFrom,
  retentionPerPage,
  segmentSamples,
  strippedHeapCap,
  type BuildSample,
} from "./build-verdict.js";

const MB = 1024 * 1024;

const rising = (values: number[]): BuildSample[] =>
  values.map((mb, index) => ({ atMs: index * 1000, rssBytes: mb * MB }));

describe("segmentSamples", () => {
  it("takes the last reading of each equal slice", () => {
    const samples = rising([100, 200, 300, 400]);
    expect(segmentSamples(samples, 2)).toEqual([200 * MB, 400 * MB]);
  });

  it("keeps a climb a climb instead of averaging it flat", () => {
    const levels = segmentSamples(rising([100, 150, 200, 250, 300, 350]), 3);
    expect(levels).toEqual([150 * MB, 250 * MB, 350 * MB]);
  });

  it("returns nothing when every sample lands at the same instant", () => {
    const samples: BuildSample[] = [
      { atMs: 5, rssBytes: MB },
      { atMs: 5, rssBytes: 2 * MB },
    ];
    expect(segmentSamples(samples, 4)).toEqual([]);
  });

  it("returns nothing for an empty window or no segments", () => {
    expect(segmentSamples([], 4)).toEqual([]);
    expect(segmentSamples(rising([1, 2]), 0)).toEqual([]);
  });
});

describe("classifyBuildSamples", () => {
  it("calls a worker that climbs every segment a leak", () => {
    // The 16.3.1 shape: 1.07 GB to 2.96 GB across the generation phase.
    const samples = rising([1070, 1400, 1930, 2380, 2550, 2700, 2960]);
    const { trend } = classifyBuildSamples(samples);

    expect(trend.verdict).toBe("leak");
  });

  it("calls a worker that holds its level stable", () => {
    // The 16.2.12 control: same build, flat between 428 and 530 MB.
    const samples = rising([428, 500, 512, 507, 524, 519, 529]);
    expect(classifyBuildSamples(samples).trend.verdict).toBe("stable");
  });

  it("is undecided when the build was too short to fill its segments", () => {
    // Better undecided than implying health from two readings.
    const samples = rising([400, 900]);
    expect(classifyBuildSamples(samples).trend.verdict).toBe("inconclusive");
  });

  it("reads the verdict from six segments", () => {
    expect(BUILD_SEGMENTS).toBe(6);
    const { levels } = classifyBuildSamples(rising([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    expect(levels).toHaveLength(6);
  });
});

describe("retentionPerPage", () => {
  it("reports the per-page figure the issue is quoted in", () => {
    // 1600 pages between the first analyzed level and the last, ~0.97 MB each.
    const levels = [1070 * MB, 1200 * MB, 1700 * MB, 2200 * MB, 2752 * MB];
    const perPage = retentionPerPage(levels, 1600);

    expect(perPage).not.toBeNull();
    expect((perPage ?? 0) / MB).toBeCloseTo(0.97, 1);
  });

  it("invents no denominator when the page count is unknown", () => {
    expect(retentionPerPage([100 * MB, 200 * MB], null)).toBeNull();
    expect(retentionPerPage([100 * MB, 200 * MB], 0)).toBeNull();
  });

  it("reports nothing for a build that did not grow", () => {
    expect(retentionPerPage([200 * MB, 190 * MB, 180 * MB], 500)).toBeNull();
  });
});

describe("netGrowthOf", () => {
  it("measures from the first analyzed level, skipping worker warm-up", () => {
    expect(netGrowthOf([100 * MB, 200 * MB, 500 * MB])).toBe(300 * MB);
  });

  it("is zero for a series with nothing in it", () => {
    expect(netGrowthOf([])).toBe(0);
  });
});

describe("strippedHeapCap", () => {
  it("warns about the cap Next removes from the worker", () => {
    // Verified by measurement: --max-old-space-size=50 lets the build finish,
    // --max-heap-size=50 kills it in 374 ms.
    const warning = strippedHeapCap("--max-old-space-size=2048");

    expect(warning).toContain("never sees it");
    expect(warning).toContain("--max-heap-size=2048");
  });

  it("names the replacement as a NODE_OPTIONS value, not a CLI flag", () => {
    // Bare "--max-heap-size=2048" reads as an option of next-leak itself, which
    // rejects it as unknown. The cap only survives inside NODE_OPTIONS.
    const warning = strippedHeapCap("--max-old-space-size=2048");

    expect(warning).toContain("Set NODE_OPTIONS=--max-heap-size=2048 instead");
  });

  it("also catches the underscore spelling Next strips", () => {
    expect(strippedHeapCap("--max_old_space_size=4096")).toContain(
      "NODE_OPTIONS=--max-heap-size=4096"
    );
  });

  it("stays quiet for a cap the worker actually inherits", () => {
    expect(strippedHeapCap("--max-heap-size=2048")).toBeNull();
  });

  it("stays quiet when nothing is set", () => {
    expect(strippedHeapCap(undefined)).toBeNull();
    expect(strippedHeapCap("")).toBeNull();
  });
});

describe("diedOfHeapExhaustion", () => {
  it("recognises the fatal error the worker dies with", () => {
    const output =
      "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory";
    expect(diedOfHeapExhaustion(output)).toBe(true);
  });

  it("recognises an explicit heap limit being reached", () => {
    expect(diedOfHeapExhaustion("FATAL ERROR: Reached heap limit Allocation failed")).toBe(true);
  });

  it("does not read an ordinary build failure as an OOM", () => {
    expect(diedOfHeapExhaustion("Type error: Property 'x' does not exist")).toBe(false);
  });
});

describe("pagesGeneratedFrom", () => {
  it("reads how far a finished build got", () => {
    const output = "✓ Generating static pages using 1 worker (2504/2504) in 49s";
    expect(pagesGeneratedFrom(output)).toBe(2504);
  });

  it("reads how far a build got before it died", () => {
    const output = [
      "Generating static pages (100/2504)",
      "Generating static pages (1700/2504)",
      "FATAL ERROR: JavaScript heap out of memory",
    ].join("\n");
    expect(pagesGeneratedFrom(output)).toBe(1700);
  });

  it("ignores counters that are not about pages", () => {
    expect(pagesGeneratedFrom("Compiled successfully (12/12)")).toBeNull();
  });

  it("returns null when the build never printed a count", () => {
    expect(pagesGeneratedFrom("")).toBeNull();
  });
});
