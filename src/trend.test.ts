import { describe, expect, it } from "vitest";
import {
  classifyMemoryTrend,
  classifyTrend,
  minGrowthFor,
  MIN_GROWTH_NOISE_FLOOR,
} from "./trend.js";

const MB = 1024 * 1024;
const KIB = 1024;

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

// The gate used to be a flat 256 KiB per cycle while the headline was
// normalized per 1000 requests. That made the verdict a function of
// `--requests` — a flag advertised as affecting duration — while the number
// printed next to it stayed identical. Same route, same reported rate, two
// different verdicts.
describe("minGrowthFor", () => {
  it("keeps the validated 256 KiB gate at the default 5000 requests per cycle", () => {
    expect(minGrowthFor(5000)).toBe(MIN_GROWTH_NOISE_FLOOR);
    expect(minGrowthFor(5000)).toBe(256 * KIB);
  });

  it("scales with traffic above the default cycle size", () => {
    expect(minGrowthFor(20_000)).toBe(4 * 256 * KIB);
    expect(minGrowthFor(10_000)).toBe(2 * 256 * KIB);
  });

  it("never drops below the noise floor, however little traffic ran", () => {
    // Under ~5000 requests a cycle the run is noise-limited: the instrument
    // cannot resolve growth smaller than its own jitter, so a lower gate would
    // report GC noise as a leak.
    expect(minGrowthFor(2000)).toBe(MIN_GROWTH_NOISE_FLOOR);
    expect(minGrowthFor(300)).toBe(MIN_GROWTH_NOISE_FLOOR);
    expect(minGrowthFor(1)).toBe(MIN_GROWTH_NOISE_FLOOR);
  });

  it("gives one verdict for one leak rate, whatever --requests was", () => {
    // A route retaining ~1 MB per 1000 requests, measured at three cycle
    // sizes. The per-cycle deltas differ by 10x; the leak does not.
    const series = (requestsPerCycle: number): number[] => {
      const perCycle = (requestsPerCycle / 1000) * MB;
      return [10 * MB, 10 * MB + perCycle, 10 * MB + 2 * perCycle, 10 * MB + 3 * perCycle];
    };
    for (const requests of [2000, 5000, 20_000]) {
      const verdict = classifyTrend(series(requests), {
        minGrowthPerCycle: minGrowthFor(requests),
      }).verdict;
      expect(verdict, `${requests} requests per cycle`).toBe("leak");
    }
  });

  it("calls sub-threshold drift stable at every cycle size", () => {
    // 10 KiB per 1000 requests: real drift, but under the gate everywhere.
    const series = (requestsPerCycle: number): number[] => {
      const perCycle = (requestsPerCycle / 1000) * 10 * KIB;
      return [10 * MB, 10 * MB + perCycle, 10 * MB + 2 * perCycle, 10 * MB + 3 * perCycle];
    };
    for (const requests of [2000, 5000, 20_000]) {
      const verdict = classifyTrend(series(requests), {
        minGrowthPerCycle: minGrowthFor(requests),
      }).verdict;
      expect(verdict, `${requests} requests per cycle`).toBe("stable");
    }
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

  it("leaves an oscillating route undecided once the dip is dwarfed by the climb", () => {
    // A healthy route gives back a real share of what it took, and this one
    // draws down 20% of net growth — but it also averages 6 MB per cycle,
    // 24x the gate. Give-back only acquits while the growth around it is
    // small; every healthy route ever measured here averaged under 2x.
    const samples = [10 * MB, 20 * MB, 30 * MB, 28 * MB, 38 * MB];
    expect(classifyTrend(samples).verdict).toBe("inconclusive");
  });

  it("still calls a modest oscillating route stable, however small the dip", () => {
    // Same shape, scaled to the magnitude of a real healthy route: 0.3 MB per
    // cycle against the 256 KiB gate.
    const samples = [10 * MB, 20 * MB, 20.5 * MB, 20.4 * MB, 20.9 * MB];
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

// An app that dies of OOM must not come back `stable`. The acquittal for a
// flat or negative cycle is bounded by how much the series grew around it.
describe("withdrawn acquittal on large oscillating series", () => {
  // Real measurement, 2026-08-17: the repro of vercel/next.js#97424 measured
  // at 300 requests per cycle. The process was killed at a 512 MB heap cap and
  // again at 1024 MB, and peaked at 4577 MB RSS; this run reported `stable`.
  const ISSUE_97424 = [861.7, 129.4, 253.0, 179.1, 107.1, 184.1, 235.5].map((mb) => mb * MB);
  const GATE_AT_300_REQUESTS = minGrowthFor(300);

  it("leaves the #97424 series undecided instead of calling it stable", () => {
    const result = classifyTrend(ISSUE_97424, { minGrowthPerCycle: GATE_AT_300_REQUESTS });
    expect(result.verdict).toBe("inconclusive");
  });

  it("does not turn the #97424 series into an accusation", () => {
    // A magnitude is not a shape: the evidence defeats the acquittal without
    // supporting a leak verdict.
    const result = classifyTrend(ISSUE_97424, { minGrowthPerCycle: GATE_AT_300_REQUESTS });
    expect(result.verdict).not.toBe("leak");
  });

  it("keeps the measured healthy routes on the acquitted side of the line", () => {
    // The phase-0 fixtures that do reach this branch: both dip, and both
    // average well under 2x the gate. The 8x line has to clear them by a wide
    // margin or the July false positives come back through another door.
    const macos = [29.4 * MB, 31.5 * MB, 32.3 * MB, 32.1 * MB];
    const linux = [28.0 * MB, 32.3 * MB, 32.1 * MB, 33.2 * MB];

    expect(classifyTrend(macos).verdict).toBe("stable");
    expect(classifyTrend(linux).verdict).toBe("stable");
  });

  it("withdraws the acquittal from the same shape scaled up tenfold", () => {
    // Identical curve shape to the healthy Linux fixture, ten times the
    // magnitude. Shape alone no longer decides it.
    const samples = [280 * MB, 323 * MB, 321 * MB, 332 * MB];
    expect(classifyTrend(samples).verdict).toBe("inconclusive");
  });

  it("acquits a large oscillation that ends where it started", () => {
    // Net growth of zero over the analyzed window is a transient, however big
    // the swings: the series has to be going somewhere.
    const samples = [10 * MB, 40 * MB, 90 * MB, 30 * MB, 40 * MB];
    expect(classifyTrend(samples).verdict).toBe("stable");
  });

  it("acquits a large oscillation that ends below where it started", () => {
    const samples = [10 * MB, 40 * MB, 90 * MB, 30 * MB, 35 * MB];
    expect(classifyTrend(samples).verdict).toBe("stable");
  });

  it("withdraws the acquittal on external memory too", () => {
    const flatHeap = [10 * MB, 11 * MB, 11 * MB, 11 * MB, 11 * MB];
    const result = classifyMemoryTrend(flatHeap, ISSUE_97424, {
      minGrowthPerCycle: GATE_AT_300_REQUESTS,
    });

    expect(result.verdict).toBe("inconclusive");
    expect(result.source).toBe("external");
  });
});

describe("saturating growth", () => {
  // Shape taken from the `use cache` route measured on 2026-08-27 against
  // Next 16.3.3: a fresh cache key per request grows every cycle, so `allGrow`
  // alone called it a leak at +603 MB/1000 requests while nothing was leaking.
  it("calls a decelerating series saturating rather than a leak", () => {
    const samples = [28 * MB, 30 * MB, 38 * MB, 42 * MB, 43.5 * MB];
    const result = classifyTrend(samples);
    expect(result.verdict).toBe("saturating");
    expect(result.deltas).toEqual([8 * MB, 4 * MB, 1.5 * MB]);
  });

  it("keeps a linear series a leak", () => {
    const samples = [28 * MB, 30 * MB, 34 * MB, 38 * MB, 42 * MB];
    expect(classifyTrend(samples).verdict).toBe("leak");
  });

  it("keeps a stepwise series a leak, which saturation cannot reach", () => {
    // Cycles below the gate keep this out of `allGrow` entirely.
    const samples = [28 * MB, 30 * MB, 40 * MB, 40 * MB, 50 * MB];
    expect(classifyTrend(samples).verdict).toBe("leak");
  });

  it("keeps a series that stops dead a leak, not saturating", () => {
    // [8, 3, 0] MB. Growth that halts without handing anything back is a
    // staircase, and stepwise detection owns it: a cache that stops is
    // indistinguishable from a leak pausing. Saturation is for curves that
    // bend, not for ones that hit a wall.
    const samples = [28 * MB, 30 * MB, 38 * MB, 41 * MB, 41 * MB];
    expect(classifyTrend(samples).verdict).toBe("leak");
  });

  it("stays a leak when deltas decrease but the last stays above half the first", () => {
    // [8, 6, 5] MB: decelerating, but nowhere near running out.
    const samples = [28 * MB, 30 * MB, 38 * MB, 44 * MB, 49 * MB];
    expect(classifyTrend(samples).verdict).toBe("leak");
  });

  it("needs three cycles before calling a bend", () => {
    // [8, 2] MB decelerates hard, but two deltas are a pair, not a trend.
    const samples = [28 * MB, 30 * MB, 38 * MB, 40 * MB];
    expect(classifyTrend(samples).verdict).toBe("leak");
  });

  it("ranks saturating between inconclusive and stable across memory sources", () => {
    const saturatingSamples = [28 * MB, 30 * MB, 38 * MB, 42 * MB, 43.5 * MB];
    const stableSamples = [10 * MB, 11 * MB, 11.1 * MB, 11.0 * MB, 11.2 * MB];
    const result = classifyMemoryTrend(stableSamples, saturatingSamples);
    expect(result.verdict).toBe("saturating");
    expect(result.source).toBe("external");
  });
});

describe("saturation reached at the tail", () => {
  // Field series, Next 16.3.4 on 2026-09-03: a `use cache` route at 3000
  // requests per cycle, gate 262 144 B. Deltas
  // [598048, 677536, 465744, 435992, 892616, 447464, 252504]. The closing
  // cycle is 96% of the gate, so `allGrow` was false, saturation was never
  // evaluated, and stepwise detection claimed it — a curve that flattens has
  // no drawdown. The verdict was `leak` on a route whose growth had stopped
  // reaching the leak rate. A control fixture with `'use cache'` removed
  // entirely reported the same +0.17 MB/1000 req, so this was never even
  // cache residency.
  const FIELD_SAMPLES = [
    30907912, 32686936, 33284984, 33962520, 34428264, 34864256, 35756872, 36204336, 36456840,
  ];

  it("calls the field series saturating once the tail is admissible", () => {
    const result = classifyTrend(FIELD_SAMPLES, { minGrowthPerCycle: minGrowthFor(3000) });
    expect(result.deltas).toEqual([598048, 677536, 465744, 435992, 892616, 447464, 252504]);
    expect(result.verdict).toBe("saturating");
  });

  it("bends despite stepping up twice on the way down", () => {
    // The same shape, stated plainly: monotonicity is not required, arrival
    // and direction are.
    const samples = [28 * MB, 30 * MB, 38 * MB, 45 * MB, 49 * MB, 58 * MB, 61 * MB, 62 * MB];
    const result = classifyTrend(samples);
    expect(result.deltas).toEqual([8 * MB, 7 * MB, 4 * MB, 9 * MB, 3 * MB, 1 * MB]);
    expect(result.verdict).toBe("saturating");
  });

  it("keeps a halt a leak even when the rest of the curve bends", () => {
    // Identical to the bend above except the closing cycle is 0: a wall, not
    // a curve, and stepwise detection keeps it.
    const samples = [28 * MB, 30 * MB, 38 * MB, 45 * MB, 49 * MB, 58 * MB, 61 * MB, 61 * MB];
    const result = classifyTrend(samples);
    expect(result.deltas).toEqual([8 * MB, 7 * MB, 4 * MB, 9 * MB, 3 * MB, 0]);
    expect(result.verdict).toBe("leak");
  });

  it("refuses a series that never grew at the leak rate to begin with", () => {
    // Deltas well under the gate throughout: nothing to decelerate from, and
    // small consistent drift is measurement noise, not a store filling up.
    const samples = [
      10 * MB,
      11 * MB,
      11 * MB + 60 * KIB,
      11 * MB + 100 * KIB,
      11 * MB + 120 * KIB,
    ];
    expect(classifyTrend(samples).verdict).not.toBe("saturating");
  });

  it("refuses a decline that arrives nowhere", () => {
    // Later cycles below earlier ones, but the closing cycle is still 75% of
    // the opening one: running slower, not running out.
    const samples = [28 * MB, 30 * MB, 38 * MB, 45.5 * MB, 52.5 * MB, 58.5 * MB];
    const result = classifyTrend(samples);
    expect(result.deltas).toEqual([8 * MB, 7.5 * MB, 7 * MB, 6 * MB]);
    expect(result.verdict).toBe("leak");
  });
});

describe("cache-driven context", () => {
  it("records the context without moving the verdict", () => {
    // Same series, both ways round: the flag is disclosure, not a threshold.
    const samples = [28 * MB, 30 * MB, 34 * MB, 38 * MB, 42 * MB];
    const plain = classifyTrend(samples);
    const driven = classifyTrend(samples, { cacheDriven: true });

    expect(driven.verdict).toBe(plain.verdict);
    expect(driven.growthPerCycle).toBe(plain.growthPerCycle);
    expect(driven.cacheDriven).toBe(true);
    expect(plain.cacheDriven).toBeUndefined();
  });

  it("leaves a healthy series stable when the cache was driven", () => {
    const samples = [29.4 * MB, 31.5 * MB, 32.3 * MB, 32.1 * MB];
    expect(classifyTrend(samples, { cacheDriven: true }).verdict).toBe("stable");
  });

  it("carries the context through the two-source verdict", () => {
    const heap = [28 * MB, 30 * MB, 34 * MB, 38 * MB, 42 * MB];
    const external = [1 * MB, 1.1 * MB, 1.1 * MB, 1.0 * MB, 1.1 * MB];
    const result = classifyMemoryTrend(heap, external, { cacheDriven: true });

    expect(result.verdict).toBe("leak");
    expect(result.cacheDriven).toBe(true);
  });
});
