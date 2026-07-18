import { describe, expect, it } from "vitest";
import { classifyMemoryTrend, classifyTrend } from "./trend.js";

const MB = 1024 * 1024;

// The fixtures below are real measurements from the phase-0 manual validation
// (2026-07-20): Next.js 16.0.1 standalone, 5000 requests per cycle, forced GC
// and 25-30s idle before each sample.

describe("classifyTrend", () => {
  it("flags the deliberately leaky route (module-level array) as a leak", () => {
    // /leaky route: baseline, then three cycles.
    const samples = [29.1 * MB, 30.5 * MB, 33.6 * MB, 35.9 * MB];
    const result = classifyTrend(samples);
    expect(result.verdict).toBe("leak");
    expect(result.growthPerCycle).toBeGreaterThan(2 * MB);
  });

  it("classifies a healthy fetch route as stable despite warm-up growth", () => {
    // / route on macOS/Node 24: +2.1 MB on cycle 1 (JIT warm-up), then flat.
    const samples = [29.4 * MB, 31.5 * MB, 32.3 * MB, 32.1 * MB];
    expect(classifyTrend(samples).verdict).toBe("stable");
  });

  it("classifies a healthy route in a Linux container as stable", () => {
    // / route in Docker (node:22-alpine): cycle 3 has transient external noise.
    const samples = [28.0 * MB, 32.3 * MB, 32.1 * MB, 33.2 * MB];
    expect(classifyTrend(samples).verdict).toBe("stable");
  });

  it("returns inconclusive when there are fewer than three cycles", () => {
    const samples = [29.4 * MB, 31.5 * MB, 32.3 * MB];
    expect(classifyTrend(samples).verdict).toBe("inconclusive");
  });

  it("respects a custom growth threshold", () => {
    const samples = [10 * MB, 11 * MB, 11.2 * MB, 11.4 * MB];
    expect(classifyTrend(samples, { minGrowthPerCycle: 0.1 * MB }).verdict).toBe("leak");
    expect(classifyTrend(samples, { minGrowthPerCycle: MB }).verdict).toBe("stable");
  });
});

// The mutation run exposed that no unit test ever produced `inconclusive` —
// the verdict real users get (14 routes on a production app) had no coverage,
// and thresholds were never exercised at their exact boundaries.
describe("classifyTrend boundaries", () => {
  const MIN = 256 * 1024; // DEFAULT_MIN_GROWTH

  it("returns inconclusive on irregular growth: never flat, mean above threshold", () => {
    // The real-world shape (measured on a production app): every cycle grows,
    // none reaches the leak threshold on its own, but the mean does.
    const samples = [10 * MB, 11 * MB, 11 * MB + 3 * MIN, 11 * MB + 3.5 * MIN];
    const result = classifyTrend(samples);
    expect(result.verdict).toBe("inconclusive");
    expect(result.deltas).toHaveLength(2);
  });

  it("treats small consistent growth below the threshold as stable noise", () => {
    const samples = [10 * MB, 11 * MB, 11 * MB + 0.4 * MIN, 11 * MB + 0.8 * MIN];
    expect(classifyTrend(samples).verdict).toBe("stable");
  });

  it("treats a perfectly flat cycle (delta exactly 0) as stable", () => {
    const samples = [10 * MB, 11 * MB, 11 * MB, 11 * MB + 5 * MIN];
    expect(classifyTrend(samples).verdict).toBe("stable");
  });

  it("counts growth exactly at the threshold as leaking", () => {
    const samples = [10 * MB, 11 * MB, 11 * MB + MIN, 11 * MB + 2 * MIN];
    expect(classifyTrend(samples).verdict).toBe("leak");
  });

  it("stays inconclusive when the mean sits exactly at the threshold", () => {
    // deltas: MIN/2 and 3*MIN/2 → mean exactly MIN, and no flat/down cycle.
    const samples = [10 * MB, 11 * MB, 11 * MB + MIN / 2, 11 * MB + 2 * MIN];
    const result = classifyTrend(samples);
    expect(result.growthPerCycle).toBe(MIN);
    expect(result.verdict).toBe("inconclusive");
  });

  it("reports the arithmetic mean of the post-warm-up deltas", () => {
    const samples = [10 * MB, 20 * MB, 24 * MB, 30 * MB];
    // deltas: 4 MB and 6 MB → mean 5 MB
    expect(classifyTrend(samples).growthPerCycle).toBe(5 * MB);
  });

  it("uses 256 KiB as the default threshold", () => {
    const justUnder = [10 * MB, 11 * MB, 11 * MB + MIN - 1, 11 * MB + 2 * MIN - 2];
    const justAt = [10 * MB, 11 * MB, 11 * MB + MIN, 11 * MB + 2 * MIN];
    // One byte below the threshold on every cycle is not a leak…
    expect(classifyTrend(justUnder).verdict).not.toBe("leak");
    // …exactly at it, on every cycle, is.
    expect(classifyTrend(justAt).verdict).toBe("leak");
  });
});

// vercel/next.js#92287 reports 4.3 GB of arrayBuffers with a healthy heap.
// Judging the heap alone would have called that process "stable" on its way
// to an OOM kill.
describe("classifyMemoryTrend", () => {
  const MIN = 256 * 1024;
  const flat = [10 * MB, 11 * MB, 11 * MB, 11 * MB];
  const growing = [1 * MB, 2 * MB, 2 * MB + 5 * MIN, 2 * MB + 10 * MIN];

  it("reports a leak when external memory grows and the heap does not", () => {
    const result = classifyMemoryTrend(flat, growing);
    expect(result.verdict).toBe("leak");
    expect(result.source).toBe("external");
  });

  it("keeps the heap verdict when the heap is the one leaking", () => {
    const result = classifyMemoryTrend(growing, flat);
    expect(result.verdict).toBe("leak");
    expect(result.source).toBe("heap");
  });

  it("stays stable only when both memories are stable", () => {
    const result = classifyMemoryTrend(flat, flat);
    expect(result.verdict).toBe("stable");
  });

  it("takes the worse of the two verdicts", () => {
    // heap inconclusive, external leaking → leak wins.
    const irregular = [10 * MB, 11 * MB, 11 * MB + 3 * MIN, 11 * MB + 3.5 * MIN];
    expect(classifyMemoryTrend(irregular, growing).verdict).toBe("leak");
    // heap stable, external inconclusive → inconclusive wins.
    const externalIrregular = [1 * MB, 2 * MB, 2 * MB + 3 * MIN, 2 * MB + 3.5 * MIN];
    const mixed = classifyMemoryTrend(flat, externalIrregular);
    expect(mixed.verdict).toBe("inconclusive");
    expect(mixed.source).toBe("external");
  });
});

// vercel/next.js#95094 — "stepwise heap growth". Measured against the real
// reproduction: the heap climbs in steps and pauses, never giving anything
// back. Judging per-cycle deltas alone called this `stable` because three of
// the seven deltas landed on zero, hiding a 110 MB leak.
describe("stepwise growth", () => {
  const MIN = 256 * 1024;

  it("calls a heap that climbs in steps and never recovers a leak", () => {
    // Real measurement: 8 cycles against the #95094 reproduction.
    const samples = [28.7, 40.3, 59.1, 75.9, 75.9, 101.2, 101.2, 139.0, 139.0].map(
      (mb) => mb * MB
    );
    const result = classifyTrend(samples);

    expect(result.verdict).toBe("leak");
    expect(result.growthPerCycle).toBeGreaterThan(10 * MB);
  });

  it("still calls an oscillating route stable, however small the dip", () => {
    // A healthy route gives back a real share of what it took. Measured
    // healthy routes drew down 22–33% of net growth; this is 20%.
    const samples = [10 * MB, 20 * MB, 30 * MB, 28 * MB, 38 * MB];
    expect(classifyTrend(samples).verdict).toBe("stable");
  });

  it("needs more than one cycle above the threshold to call it stepwise", () => {
    // One step and one flat cycle is not a pattern — it is a single bump.
    const samples = [10 * MB, 11 * MB, 11 * MB, 11 * MB + 5 * MIN];
    expect(classifyTrend(samples).verdict).toBe("stable");
  });

  it("does not call a flat series a leak just because it never dips", () => {
    const samples = [10 * MB, 11 * MB, 11 * MB, 11 * MB, 11 * MB];
    expect(classifyTrend(samples).verdict).toBe("stable");
  });

  it("ignores a dip smaller than a tenth of the net growth", () => {
    // 100 MB of net growth against a 1 MB give-back is a pause, not a plateau.
    const samples = [10 * MB, 20 * MB, 60 * MB, 59 * MB, 120 * MB];
    expect(classifyTrend(samples).verdict).toBe("leak");
  });

  it("keeps external memory judged by the same rule", () => {
    const flat = [10 * MB, 11 * MB, 11 * MB, 11 * MB];
    const stepwise = [10 * MB, 20 * MB, 40 * MB, 40 * MB, 70 * MB];
    const result = classifyMemoryTrend(flat, stepwise);

    expect(result.verdict).toBe("leak");
    expect(result.source).toBe("external");
  });
});
