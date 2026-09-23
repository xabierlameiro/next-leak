import { describe, expect, it } from "vitest";
import {
  assessPeakPressure,
  assessPressureVerdict,
  describePeakPressure,
} from "./peak-pressure.js";
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

  /** The #92287 shape: rss climbing every cycle while nothing is retained. */
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

  it("calls a route that retains nothing and keeps climbing a pressure finding", () => {
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

  it("stays stable when the peak is high but level", () => {
    // A size is not a direction: an app that reserves its working set on the
    // first cycle and holds it there is doing nothing wrong.
    expect(assess(flatTrend(), climbingPeaks([3000, 3000, 3000, 3000])).verdict).toBe(
      "stable"
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

  it("does not read allocator noise as a climb", () => {
    // A reading taken under load jitters in megabytes: arenas, pages not yet
    // returned to the OS, whatever the poll caught mid-request. The post-GC
    // gate (~256 KB) would call this a climb; the peak gate does not.
    expect(assess(flatTrend(), climbingPeaks([600, 602, 604, 606])).verdict).toBe("stable");
  });

  it("requires the climb to add up, not just to clear the gate twice", () => {
    // Per-cycle deltas of 20 MB clear the 16 MB gate, and at the default 4
    // cycles the peak series offers only two of them. 40 MB of net climb is not
    // enough to spend a verdict on.
    expect(assess(flatTrend(), climbingPeaks([600, 620, 640, 660])).verdict).toBe("stable");
  });

  it("holds a long slow drift below the per-cycle gate to be noise", () => {
    // The two gates have to be able to reject a series on their own, or one of
    // them is decoration. 80 MB of net climb clears the total, and every cycle
    // adds 10 MB: under the 16 MB a peak needs, and comfortably over the
    // ~256 KB the post-GC series is judged by. Only the per-cycle gate stands
    // between this and a verdict.
    const drift = [600, 610, 620, 630, 640, 650, 660, 670, 680];
    expect(assess(flatTrend(), climbingPeaks(drift)).verdict).toBe("stable");
  });

  // The gate is the whole rule, and one step either side decides whether a user
  // is told their process is heading for a ceiling. The boundary is inclusive,
  // like the ones `assessPeakPressure` is held to above.
  it("escalates on exactly 64 MB of net climb, and not on a megabyte less", () => {
    // Warm-up is dropped, so the climb is measured from cycle 2: 764 - 700.
    expect(assess(flatTrend(), climbingPeaks([600, 700, 732, 764])).verdict).toBe("pressure");
    expect(assess(flatTrend(), climbingPeaks([600, 700, 732, 763])).verdict).toBe("stable");
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

  it("cannot reach a verdict on three cycles", () => {
    // Documented limit, not an oversight. There is no peak before the first
    // load, so the peak series is one shorter than the post-GC one, and the
    // first cycle carries compilation the later ones do not. Three cycles
    // leave a single usable delta, which is a pair, not a trend.
    expect(assess(flatTrend(), climbingPeaks([600, 1800, 3000])).verdict).toBe("stable");
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
