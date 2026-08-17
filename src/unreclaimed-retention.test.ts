import { describe, expect, it } from "vitest";
import {
  assessUnreclaimedRetention,
  describeUnreclaimedRetention,
} from "./unreclaimed-retention.js";
import type { TrendResult } from "./trend.js";

const MB = 1024 * 1024;

const growing = (source: "heap" | "external" = "heap"): TrendResult => ({
  verdict: "leak",
  growthPerCycle: 10 * MB,
  deltas: [10 * MB, 10 * MB],
  source,
});

const flat: TrendResult = {
  verdict: "stable",
  growthPerCycle: 0.05 * MB,
  deltas: [-0.1 * MB, 0.2 * MB],
  source: "heap",
};

describe("assessUnreclaimedRetention", () => {
  it("reports memory held before collection that a GC takes back", () => {
    // The vercel/next.js#96533 shape: climbs before collection, flat after it.
    const retention = assessUnreclaimedRetention({
      unreclaimedTrend: growing(),
      verdict: "stable",
      requestsPerCycle: 2000,
    });

    expect(retention).not.toBeNull();
    expect(retention?.class).toBe("heap");
    expect(retention?.growthPer1000Requests).toBe(5 * MB);
  });

  it("names external memory when that is the class that grew", () => {
    const retention = assessUnreclaimedRetention({
      unreclaimedTrend: growing("external"),
      verdict: "stable",
      requestsPerCycle: 2000,
    });

    expect(retention?.class).toBe("external");
  });

  it("stays quiet when the route already leaks", () => {
    // The retention is the headline there; a weaker restatement is noise.
    expect(
      assessUnreclaimedRetention({
        unreclaimedTrend: growing(),
        verdict: "leak",
        requestsPerCycle: 2000,
      })
    ).toBeNull();
  });

  it("stays quiet when nothing accumulates before collection", () => {
    expect(
      assessUnreclaimedRetention({
        unreclaimedTrend: flat,
        verdict: "stable",
        requestsPerCycle: 2000,
      })
    ).toBeNull();
  });

  it("stays quiet when the pre-collection series is merely undecided", () => {
    // That series is noisy by nature — nothing has been collected — so only a
    // series that grows every cycle is worth interrupting a run for.
    expect(
      assessUnreclaimedRetention({
        unreclaimedTrend: { ...growing(), verdict: "inconclusive" },
        verdict: "stable",
        requestsPerCycle: 2000,
      })
    ).toBeNull();
  });

  it("stays quiet when the series was dropped and carries no growth", () => {
    expect(
      assessUnreclaimedRetention({
        unreclaimedTrend: { verdict: "leak", growthPerCycle: 0, deltas: [] },
        verdict: "stable",
        requestsPerCycle: 2000,
      })
    ).toBeNull();
  });

  it("does not divide by a cycle that served no requests", () => {
    expect(
      assessUnreclaimedRetention({
        unreclaimedTrend: growing(),
        verdict: "stable",
        requestsPerCycle: 0,
      })
    ).toBeNull();
  });

  it("reports the same finding for an inconclusive verdict", () => {
    // Only `leak` silences it: an undecided route can still be sitting on
    // memory nothing has collected.
    expect(
      assessUnreclaimedRetention({
        unreclaimedTrend: growing(),
        verdict: "inconclusive",
        requestsPerCycle: 2000,
      })
    ).not.toBeNull();
  });
});

describe("describeUnreclaimedRetention", () => {
  it("states the rate, the class and its own limits", () => {
    const line = describeUnreclaimedRetention({
      class: "external",
      growthPerCycle: 10 * MB,
      growthPer1000Requests: 5 * MB,
    });

    expect(line).toContain("external memory");
    expect(line).toContain("5.00 MB/1000 req");
    // Never contradicts the verdict beside it, and never overstates itself.
    expect(line).toContain("a forced GC reclaims this");
    expect(line).toContain("seconds after load");
    expect(line).toContain("while staying flat after it");
  });

  it("names the heap when the heap is what grew", () => {
    const line = describeUnreclaimedRetention({
      class: "heap",
      growthPerCycle: 4 * MB,
      growthPer1000Requests: 2 * MB,
    });

    expect(line).toContain("heap grew 2.00 MB/1000 req");
    expect(line).not.toContain("external memory");
  });
});
