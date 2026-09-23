import { describe, expect, it } from "vitest";
import {
  assessPeakPressure,
  assessPressureVerdict,
  describePeakPressure,
  retainedAfterLoad,
} from "./peak-pressure.js";
import type { HeapSample } from "./control-server.js";
import type { PeakSample } from "./ritual.js";
import type { TrendResult, TrendVerdict } from "./trend.js";

const MB = 1024 * 1024;

const peak = (overrides: Partial<PeakSample> = {}): PeakSample => ({
  phase: "cycle 1",
  heapUsed: 20 * MB,
  external: 1 * MB,
  arrayBuffers: 1 * MB,
  rss: 60 * MB,
  polls: 40,
  ...overrides,
});

describe("retainedAfterLoad", () => {
  const sample = (heapUsedMb: number): HeapSample => ({
    gcExposed: true,
    heapUsed: heapUsedMb * MB,
    rss: 600 * MB,
    external: 1 * MB,
    arrayBuffers: 1 * MB,
  });

  it("takes the floor of the cycle samples, not the last of them", () => {
    // Measured on the vercel/next.js#92287 reproduction, 2026-09-24. Every one
    // of these follows a forced GC and they still swing by 5x, so the last one
    // is a coin toss: 194.9 MB here, 41.0 MB on the next run of the same app.
    const samples = [55.6, 217.1, 125.0, 45.2, 194.9].map(sample);
    expect(retainedAfterLoad(samples)).toBe(45.2 * MB);
  });

  it("ignores the baseline, which precedes any traffic", () => {
    // A route retains nothing before it has served anything. Dividing by that
    // would make every route on earth look disproportionate to its peak.
    expect(retainedAfterLoad([sample(10), sample(200), sample(300)])).toBe(200 * MB);
  });

  it("says nothing when no cycle was sampled", () => {
    expect(retainedAfterLoad([sample(10)])).toBeUndefined();
    expect(retainedAfterLoad([])).toBeUndefined();
  });
});

describe("assessPeakPressure", () => {
  it("fires when the peak heap approaches the configured limit", () => {
    const pressure = assessPeakPressure({
      peaks: [peak({ heapUsed: 410 * MB })],
      retainedHeapBytes: 30 * MB,
      maxOldSpaceMb: 512,
    });
    expect(pressure?.class).toBe("heap");
    expect(pressure?.peakBytes).toBe(410 * MB);
  });

  it("fires when the process transiently holds far more rss than it retains", () => {
    // The shape measured on the vercel/next.js#92287 repro: 3.8 GB reached,
    // 30 MB retained, verdict stable.
    const pressure = assessPeakPressure({
      peaks: [peak({ heapUsed: 100 * MB, rss: 3800 * MB })],
      retainedHeapBytes: 30 * MB,
      maxOldSpaceMb: 6144,
    });
    expect(pressure?.class).toBe("rss");
    expect(pressure?.peakBytes).toBe(3800 * MB);
  });

  it("stays quiet on a small app that peaks proportionally high", () => {
    // 10x its retained heap, and operationally nothing.
    expect(
      assessPeakPressure({
        peaks: [peak({ heapUsed: 20 * MB, rss: 40 * MB })],
        retainedHeapBytes: 4 * MB,
        maxOldSpaceMb: 512,
      })
    ).toBeNull();
  });

  it("stays quiet on a heavy but proportionate process", () => {
    expect(
      assessPeakPressure({
        peaks: [peak({ heapUsed: 200 * MB, rss: 900 * MB })],
        retainedHeapBytes: 700 * MB,
        maxOldSpaceMb: 4096,
      })
    ).toBeNull();
  });

  it("takes the highest peak across cycles", () => {
    const pressure = assessPeakPressure({
      peaks: [
        peak({ rss: 600 * MB }),
        peak({ phase: "cycle 2", rss: 2000 * MB }),
        peak({ phase: "cycle 3", rss: 900 * MB }),
      ],
      retainedHeapBytes: 30 * MB,
      maxOldSpaceMb: 4096,
    });
    expect(pressure?.peakBytes).toBe(2000 * MB);
  });

  // The thresholds are the whole rule: one step either side decides whether a
  // user is told their process nearly died. Both boundaries are inclusive.
  it("fires exactly at 75% of the heap limit", () => {
    const atThreshold = assessPeakPressure({
      peaks: [peak({ heapUsed: 384 * MB })],
      retainedHeapBytes: 30 * MB,
      maxOldSpaceMb: 512,
    });
    expect(atThreshold?.class).toBe("heap");

    const justBelow = assessPeakPressure({
      peaks: [peak({ heapUsed: 383 * MB, rss: 100 * MB })],
      retainedHeapBytes: 30 * MB,
      maxOldSpaceMb: 512,
    });
    expect(justBelow).toBeNull();
  });

  it("fires exactly at the rss floor and at exactly 8× the retained heap", () => {
    const atFloor = assessPeakPressure({
      peaks: [peak({ heapUsed: 100 * MB, rss: 512 * MB })],
      retainedHeapBytes: 64 * MB,
      maxOldSpaceMb: 4096,
    });
    expect(atFloor?.class).toBe("rss");

    const justUnderFloor = assessPeakPressure({
      peaks: [peak({ heapUsed: 100 * MB, rss: 511 * MB })],
      retainedHeapBytes: 64 * MB,
      maxOldSpaceMb: 4096,
    });
    expect(justUnderFloor).toBeNull();

    const justUnderRatio = assessPeakPressure({
      peaks: [peak({ heapUsed: 100 * MB, rss: 600 * MB })],
      retainedHeapBytes: 100 * MB,
      maxOldSpaceMb: 4096,
    });
    expect(justUnderRatio).toBeNull();
  });

  it("ignores a cycle whose poller never read anything", () => {
    // Contract, not arithmetic: a reading that never happened is not a peak,
    // whatever numbers happen to sit in the record.
    const pressure = assessPeakPressure({
      peaks: [
        peak({ phase: "cycle 1", heapUsed: 100 * MB, rss: 600 * MB }),
        peak({ phase: "cycle 2", heapUsed: 9000 * MB, rss: 9000 * MB, polls: 0 }),
      ],
      retainedHeapBytes: 30 * MB,
      maxOldSpaceMb: 4096,
    });
    expect(pressure?.peakBytes).toBe(600 * MB);
  });

  it("says nothing when no reading was ever taken", () => {
    expect(
      assessPeakPressure({
        peaks: [peak({ polls: 0, rss: 0, heapUsed: 0 })],
        retainedHeapBytes: 30 * MB,
        maxOldSpaceMb: 512,
      })
    ).toBeNull();
  });
});

describe("assessPressureVerdict", () => {
  /** Post-GC verdict of a route that hands back everything it allocates. */
  const flatTrend = (verdict: TrendVerdict = "stable"): TrendResult => ({
    verdict,
    growthPerCycle: -2 * MB,
    deltas: [-1.5 * MB, -2.5 * MB],
    source: "heap",
  });

  /** The #92287 shape: rss reaching far past what is retained, cycle after cycle. */
  const climbingPeaks = (values: readonly number[]): PeakSample[] =>
    values.map((mb, index) =>
      peak({ phase: `cycle ${index + 1}`, heapUsed: 100 * MB, rss: mb * MB })
    );

  const assess = (trend: TrendResult, peaks: readonly PeakSample[]): TrendResult =>
    assessPressureVerdict({
      trend,
      peaks,
      retainedHeapBytes: 30 * MB,
      maxOldSpaceMb: 6144,
    });

  it("calls a route that retains nothing and keeps reaching the ceiling a pressure finding", () => {
    // Measured on the vercel/next.js#92287 reproduction, 2026-09-23: ~1 MB of
    // arrayBuffers per request, over 3 GB reached, and every post-GC sample
    // back at baseline. The old verdict was `stable` at -9.00 MB/1000 requests.
    const result = assess(flatTrend(), climbingPeaks([600, 1400, 2200, 3000]));
    expect(result.verdict).toBe("pressure");
  });

  it("leaves the measured growth figure alone when it escalates the verdict", () => {
    // The raw record has to survive: only the verdict changes.
    const trend = flatTrend();
    const result = assess(trend, climbingPeaks([600, 1400, 2200, 3000]));
    expect(result.growthPerCycle).toBe(trend.growthPerCycle);
    expect(result.deltas).toEqual(trend.deltas);
    expect(result.source).toBe("heap");
  });

  it("calls a level peak pressure too, because the regime is what kills", () => {
    // Measured on the same reproduction: under this ritual the peak cannot
    // climb, because every cycle is preceded by a forced collection and runs
    // the same traffic, so it converges on traffic x cost-per-request. A run
    // that returns to the ceiling every cycle is describing what it does under
    // load, and that is the number a container is sized against.
    expect(assess(flatTrend(), climbingPeaks([3000, 3000, 3000, 3000])).verdict).toBe(
      "pressure"
    );
  });

  it("stays stable when climbing peaks stay proportionate to what is retained", () => {
    const result = assessPressureVerdict({
      trend: flatTrend(),
      peaks: climbingPeaks([3000, 3400, 3800, 4200]),
      retainedHeapBytes: 700 * MB,
      maxOldSpaceMb: 6144,
    });
    expect(result.verdict).toBe("stable");
  });

  it("stays stable when only one cycle reached the ceiling", () => {
    // An episode, not a regime: the note still fires on the 3000 MB high-water
    // mark, but one cycle that reached it for a reason that did not repeat is
    // not something to accuse a route of.
    expect(assess(flatTrend(), climbingPeaks([600, 3000, 200, 180])).verdict).toBe("stable");
  });

  it("does not count the warm-up cycle towards the regime", () => {
    // The first cycle carries compilation and lazy initialisation the later
    // ones do not, so it is dropped here exactly as the classifier drops it.
    expect(assess(flatTrend(), climbingPeaks([3000, 200, 180, 190])).verdict).toBe("stable");
  });

  it("stays stable when the last cycle comes back down", () => {
    // Whatever the run reached, it is not what this route does under load.
    expect(assess(flatTrend(), climbingPeaks([3000, 3000, 3000, 200])).verdict).toBe("stable");
  });

  it("needs a second settled cycle before it can say the word again", () => {
    // Two cycles in total leave one settled cycle, which cannot repeat itself.
    expect(assess(flatTrend(), climbingPeaks([600, 3000])).verdict).toBe("stable");
  });

  it("judges each cycle against the heap ceiling when that is the class", () => {
    // The two classes are different readings against different limits, so the
    // per-cycle rule has to branch the same way `assessPeakPressure` does.
    const heapPeaks = [3000, 3100, 3200, 3300].map((mb, index) =>
      peak({ phase: `cycle ${index + 1}`, heapUsed: mb * MB, rss: 100 * MB })
    );
    const sustained = assessPressureVerdict({
      trend: flatTrend(),
      peaks: heapPeaks,
      retainedHeapBytes: 30 * MB,
      maxOldSpaceMb: 4096,
    });
    expect(sustained.verdict).toBe("pressure");

    // One settled cycle back under 75% of 4096 MB, and the regime is broken.
    const dips = [...heapPeaks];
    dips[2] = peak({ phase: "cycle 3", heapUsed: 1000 * MB, rss: 100 * MB });
    const broken = assessPressureVerdict({
      trend: flatTrend(),
      peaks: dips,
      retainedHeapBytes: 30 * MB,
      maxOldSpaceMb: 4096,
    });
    expect(broken.verdict).toBe("stable");
  });

  it("stays stable when one cycle in the middle was never polled", () => {
    // Dropping the hole would compare cycle 2 against cycle 4 as neighbours and
    // manufacture a delta no cycle produced.
    const holed = climbingPeaks([600, 1400, 2200, 3000]);
    const gapped = holed.map((sample, index) =>
      index === 2 ? { ...sample, polls: 0 } : sample
    );
    expect(assess(flatTrend(), gapped).verdict).toBe("stable");
  });

  it("escalates a saturating verdict on the same evidence", () => {
    expect(assess(flatTrend("saturating"), climbingPeaks([600, 1400, 2200, 3000])).verdict).toBe(
      "pressure"
    );
  });

  it("never touches a leak, which is already the worse news", () => {
    expect(assess(flatTrend("leak"), climbingPeaks([600, 1400, 2200, 3000])).verdict).toBe(
      "leak"
    );
  });

  it("never promotes an inconclusive series to an accusation", () => {
    // A series nobody could call is a measurement that failed, not a finding.
    expect(
      assess(flatTrend("inconclusive"), climbingPeaks([600, 1400, 2200, 3000])).verdict
    ).toBe("inconclusive");
  });

  it("can reach a verdict on the three cycles the CLI allows at minimum", () => {
    // Three cycles leave two settled ones, which is enough to say the process
    // came back. The old four-cycle floor was there because the verdict rested
    // on deltas and the peak series has no baseline row to supply the first
    // one; with no deltas left to take, that floor had no argument behind it.
    expect(assess(flatTrend(), climbingPeaks([600, 1800, 3000])).verdict).toBe("pressure");
  });

  it("says nothing when the poller never read a peak", () => {
    const blind = climbingPeaks([600, 1400, 2200, 3000]).map((sample) => ({
      ...sample,
      polls: 0,
    }));
    expect(assess(flatTrend(), blind).verdict).toBe("stable");
  });
});

describe("describePeakPressure", () => {
  it("names the heap ceiling without contradicting the verdict", () => {
    const line = describePeakPressure({
      class: "heap",
      peakBytes: 410 * MB,
      retainedBytes: 30 * MB,
      heapLimitBytes: 512 * MB,
    });
    expect(line).toContain("410.0 MB");
    expect(line).toContain("512.0 MB");
    expect(line).toContain("highest value sampled");
    expect(line).not.toContain("leak");
  });

  it("explains the rss case in the terms an operator sizes containers in", () => {
    const line = describePeakPressure({
      class: "rss",
      peakBytes: 3800 * MB,
      retainedBytes: 30 * MB,
      heapLimitBytes: 6144 * MB,
    });
    expect(line).toContain("rss");
    expect(line).toContain("container");
  });
});
