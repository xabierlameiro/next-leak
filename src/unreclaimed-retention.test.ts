import { describe, expect, it } from "vitest";
import {
  assessUnreclaimedRetention,
  describeUnreclaimedRetention,
} from "./unreclaimed-retention.js";
import type { HeapSample } from "./control-server.js";

const MB = 1024 * 1024;

type Series = { heap: number[]; external?: number[]; arrayBuffers?: number[] };

const samples = ({ heap, external, arrayBuffers }: Series): HeapSample[] =>
  heap.map((mb, index) => ({
    gcExposed: true,
    heapUsed: mb * MB,
    rss: 3 * mb * MB,
    external: (external?.[index] ?? arrayBuffers?.[index] ?? 0) * MB,
    arrayBuffers: (arrayBuffers?.[index] ?? 0) * MB,
  }));

// Every fixture below is a real measurement taken on 2026-08-18 and recorded in
// the change's field-validation.md.

/** vercel/next.js#96533: held between collections, flat after one. */
const ISSUE_96533 = {
  unreclaimed: samples({
    heap: [46.5, 27.8, 48.0, 45.1, 39.2, 52.7],
    external: [7.77, 5.62, 8.68, 8.09, 7.0, 9.37],
    arrayBuffers: [4.11, 0.32, 5.03, 4.44, 3.35, 5.72],
  }),
  // Baseline first, then one per cycle.
  postGc: samples({
    heap: [27.1, 26.3, 27.3, 27.6, 27.8, 27.8, 27.9],
    external: [3.98, 3.98, 3.98, 3.97, 3.98, 3.98, 3.97],
    arrayBuffers: [0.32, 0.32, 0.32, 0.32, 0.32, 0.32, 0.32],
  }),
};

/** The healthy fixture route: median gap 0.77 MB, 0.11x what it retains. */
const HEALTHY = {
  unreclaimed: samples({ heap: [9.0, 7.7, 7.7, 7.9, 8.4, 8.1] }),
  postGc: samples({ heap: [7.3, 7.1, 7.1, 7.2, 7.2, 7.2, 7.3] }),
};

describe("assessUnreclaimedRetention", () => {
  it("finds the #96533 gap that the old slope rule missed entirely", () => {
    // That pre-collection series classifies as `inconclusive` on its own — it
    // oscillates rather than climbs. The gap is what carries the finding.
    const retention = assessUnreclaimedRetention({
      unreclaimedSamples: ISSUE_96533.unreclaimed,
      memorySamples: ISSUE_96533.postGc,
      verdict: "stable",
      verdictIsWellSupported: true,
    });

    expect(retention).not.toBeNull();
    expect(retention?.class).toBe("arrayBuffers");
    // The largest gap observed, not the typical one: a cycle that held 5.40 MB
    // proves the process can, while a cycle at zero only proves it had just
    // been collected.
    expect((retention?.largestGapBytes ?? 0) / MB).toBeCloseTo(5.4, 1);
  });

  it("names the class where holding is most out of proportion, not the biggest", () => {
    // The heap gap is far larger in megabytes (24.8 vs 5.40), but arrayBuffers is
    // where the process holds many times what it keeps — that names the
    // mechanism the issue describes.
    const retention = assessUnreclaimedRetention({
      unreclaimedSamples: ISSUE_96533.unreclaimed,
      memorySamples: ISSUE_96533.postGc,
      verdict: "stable",
      verdictIsWellSupported: true,
    });

    expect(retention?.class).toBe("arrayBuffers");
    expect(retention?.ratio ?? 0).toBeGreaterThan(3);
  });

  it("stays quiet on a healthy route", () => {
    expect(
      assessUnreclaimedRetention({
        unreclaimedSamples: HEALTHY.unreclaimed,
        memorySamples: HEALTHY.postGc,
        verdict: "stable",
        verdictIsWellSupported: true,
      })
    ).toBeNull();
  });

  it("is not fooled by one cycle that collected on its own", () => {
    // Cycle 2 of the real #96533 run fell back to the post-GC level because V8
    // collected just before the reading. A mean would let that drag the
    // finding down; the median holds.
    const retention = assessUnreclaimedRetention({
      unreclaimedSamples: ISSUE_96533.unreclaimed,
      memorySamples: ISSUE_96533.postGc,
      verdict: "stable",
      verdictIsWellSupported: true,
    });

    expect(retention).not.toBeNull();
  });

  it("stays quiet when the route already leaks", () => {
    expect(
      assessUnreclaimedRetention({
        unreclaimedSamples: ISSUE_96533.unreclaimed,
        memorySamples: ISSUE_96533.postGc,
        verdict: "leak",
        verdictIsWellSupported: true,
      })
    ).toBeNull();
  });

  it("is not silenced by a marginal leak carrying low-confidence warnings", () => {
    // Measured on #96533 2026-08-18: the post-GC verdict came back `leak` at
    // +0.15 MB/1000 req with two low-confidence warnings — noise grazing the
    // threshold — while the gap was 3.96 MB of arrayBuffers at 4x what the
    // route retains. Silencing on any `leak` let the weaker finding hide the
    // stronger one, and the note never appeared on the app it exists for.
    const retention = assessUnreclaimedRetention({
      unreclaimedSamples: ISSUE_96533.unreclaimed,
      memorySamples: ISSUE_96533.postGc,
      verdict: "leak",
      verdictIsWellSupported: false,
    });

    expect(retention).not.toBeNull();
    expect(retention?.class).toBe("arrayBuffers");
  });

  it("still reports on an undecided route", () => {
    expect(
      assessUnreclaimedRetention({
        unreclaimedSamples: ISSUE_96533.unreclaimed,
        memorySamples: ISSUE_96533.postGc,
        verdict: "inconclusive",
        verdictIsWellSupported: true,
      })
    ).not.toBeNull();
  });

  it("stays quiet when a large gap is small next to what is retained", () => {
    // The deliberately leaky fixture: 5.13 MB held over 24.4 MB retained, a
    // 0.21x ratio. Its memory really is retained after a GC — that is a leak,
    // not this. Clears the absolute floor, fails the ratio.
    const retention = assessUnreclaimedRetention({
      unreclaimedSamples: samples({ heap: [30.3, 45.2, 60.0, 76.0, 91.0, 105.9] }),
      memorySamples: samples({ heap: [8.8, 24.4, 40.1, 54.9, 70.5, 86.3, 102.0] }),
      verdict: "stable",
      verdictIsWellSupported: true,
    });

    expect(retention).toBeNull();
  });

  it("stays quiet when there is no pre-collection series", () => {
    expect(
      assessUnreclaimedRetention({
        unreclaimedSamples: [],
        memorySamples: HEALTHY.postGc,
        verdict: "stable",
        verdictIsWellSupported: true,
      })
    ).toBeNull();
  });

  it("pairs each cycle with its own post-GC reading, not with the baseline", () => {
    // A series that only looks like a gap when misaligned by one must not fire.
    const rising = samples({ heap: [20, 30, 40, 50, 60, 70] });
    const postGc = samples({ heap: [10, 20, 30, 40, 50, 60, 70] });

    expect(
      assessUnreclaimedRetention({
        unreclaimedSamples: rising,
        memorySamples: postGc,
        verdict: "stable",
        verdictIsWellSupported: true,
      })
    ).toBeNull();
  });

  it("ignores cycles with no matching post-GC reading", () => {
    const retention = assessUnreclaimedRetention({
      unreclaimedSamples: ISSUE_96533.unreclaimed,
      memorySamples: samples({ heap: [27.1, 26.3, 27.3] }),
      verdict: "stable",
      verdictIsWellSupported: true,
    });

    // Only two cycles pair up; the rule still runs on what it has.
    expect(retention === null || retention.largestGapBytes > 0).toBe(true);
  });
});

describe("describeUnreclaimedRetention", () => {
  it("states the gap, the class and its own limits", () => {
    const line = describeUnreclaimedRetention({
      class: "arrayBuffers",
      largestGapBytes: 3.96 * MB,
      retainedBytes: 0.32 * MB,
      ratio: 3.96,
    });

    expect(line).toContain("3.96 MB of arrayBuffers");
    expect(line).toContain("4.0x what it retains");
    expect(line).toContain("a forced GC reclaims this");
    expect(line).toContain("seconds after load");
  });

  it("labels external memory readably", () => {
    const line = describeUnreclaimedRetention({
      class: "external",
      largestGapBytes: 5 * MB,
      retainedBytes: 2 * MB,
      ratio: 2.5,
    });

    expect(line).toContain("external memory");
  });
});

// Run 3 of the real reproduction: four of six cycles collected on their own
// just before the reading, so their gap is zero. A median reports nothing
// about an app that demonstrably held 3.79 MB in another cycle.
describe("a run where most cycles happened to be collected", () => {
  const RUN_3 = {
    unreclaimed: samples({
      heap: [40, 40, 40, 40, 40, 40],
      arrayBuffers: [0.32, 1.81, 0.32, 0.32, 4.11, 0.32],
    }),
    postGc: samples({
      heap: [27.1, 26.3, 27.3, 27.6, 27.7, 27.8, 27.8],
      arrayBuffers: [0.32, 0.32, 0.32, 0.32, 0.32, 0.32, 0.32],
    }),
  };

  it("still reports what the process was seen holding", () => {
    const retention = assessUnreclaimedRetention({
      unreclaimedSamples: RUN_3.unreclaimed,
      memorySamples: RUN_3.postGc,
      verdict: "stable",
      verdictIsWellSupported: false,
    });

    expect(retention).not.toBeNull();
    expect(retention?.class).toBe("arrayBuffers");
    expect((retention?.largestGapBytes ?? 0) / MB).toBeCloseTo(3.79, 1);
  });
});

// Boundaries the mutation run found unfixed: each of these is a calibrated
// value whose exact edge nothing pinned down.
describe("threshold boundaries", () => {
  it("fires on a gap sitting exactly on the floor", () => {
    // 3 MB held against 1 MB retained: a gap of exactly 2 MB. `<` lets the
    // equal case through and `<=` would not, and the difference decides
    // whether a route on the line is reported at all.
    const retention = assessUnreclaimedRetention({
      unreclaimedSamples: samples({ heap: [3, 3, 3, 3] }),
      memorySamples: samples({ heap: [1, 1, 1, 1, 1] }),
      verdict: "stable",
      verdictIsWellSupported: true,
    });

    expect(retention).not.toBeNull();
    expect((retention?.largestGapBytes ?? 0) / MB).toBeCloseTo(2, 2);
  });

  it("measures what is retained from the cycles, not from the baseline", () => {
    // The baseline is warm-up's level, not the app's. Folding it into the
    // denominator here would make a 20 MB gap over 10 MB retained (2.0x) read
    // as 20 over 100 (0.2x) and silence the note.
    const retention = assessUnreclaimedRetention({
      unreclaimedSamples: samples({ heap: [30, 30, 30, 30] }),
      memorySamples: samples({ heap: [100, 10, 10, 10, 10] }),
      verdict: "stable",
      verdictIsWellSupported: true,
    });

    expect(retention).not.toBeNull();
    expect(retention?.retainedBytes ?? 0).toBe(10 * MB);
    expect(retention?.ratio ?? 0).toBeCloseTo(2, 1);
  });

  it("names external memory when that is the class out of proportion", () => {
    // arrayBuffers flat, external holding: the label has to follow the data.
    const retention = assessUnreclaimedRetention({
      unreclaimedSamples: samples({ heap: [10, 10, 10, 10], external: [9, 9, 9, 9] }),
      memorySamples: samples({ heap: [9, 9, 9, 9, 9], external: [1, 1, 1, 1, 1] }),
      verdict: "stable",
      verdictIsWellSupported: true,
    });

    expect(retention?.class).toBe("external");
  });
});
