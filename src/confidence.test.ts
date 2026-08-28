import { describe, expect, it } from "vitest";
import {
  assessConfidence,
  effectiveVerdict,
  warrantsIssueDraft,
  type ConfidenceInput,
} from "./confidence.js";
import type { HeapSample } from "./control-server.js";
import type { LoadOutcome, SettleOutcome } from "./ritual.js";
import type { TrendResult } from "./trend.js";

const KB = 1024;
const MB = 1024 * KB;
const MIN_GROWTH = 256 * KB;

const settled = (count: number): SettleOutcome[] =>
  Array.from({ length: count }, (_, index) => ({
    phase: `cycle ${index + 1}`,
    status: "settled" as const,
    polls: 2,
  }));

const clean = (count: number): LoadOutcome[] =>
  Array.from({ length: count }, (_, index) => ({
    phase: `cycle ${index + 1}`,
    sent: 1000,
    ok2xx: 1000,
  }));

const trend = (partial: Partial<TrendResult> = {}): TrendResult => ({
  verdict: "leak",
  growthPerCycle: 5 * MB,
  deltas: [5 * MB, 5 * MB],
  source: "heap",
  ...partial,
});

const input = (partial: Partial<ConfidenceInput> = {}): ConfidenceInput => ({
  trend: trend(),
  loadOutcomes: clean(3),
  settleOutcomes: settled(3),
  ...partial,
});

const codesOf = (result: { warnings: { code: string }[] }): string[] =>
  result.warnings.map((warning) => warning.code);

describe("assessConfidence", () => {
  it("reports high confidence when the evidence supports the verdict", () => {
    const result = assessConfidence(input());
    expect(result).toEqual({ level: "high", warnings: [] });
  });

  it("does not second-guess a clean stable measurement", () => {
    const result = assessConfidence(
      input({ trend: trend({ verdict: "stable", growthPerCycle: 0, deltas: [0, -1 * MB] }) })
    );
    expect(result.level).toBe("high");
  });
});

const allWith = (status: SettleOutcome["status"]): SettleOutcome[] =>
  settled(3).map((outcome) => ({ ...outcome, status }));

describe("settle auditing", () => {
  it("warns and names the cycles whose heap never held still", () => {
    const outcomes: SettleOutcome[] = [
      { phase: "cycle 1", status: "settled", polls: 3 },
      { phase: "cycle 2", status: "moving", polls: 15 },
      { phase: "cycle 3", status: "settled", polls: 2 },
    ];
    const result = assessConfidence(input({ settleOutcomes: outcomes }));

    expect(result.level).toBe("low");
    expect(codesOf(result)).toEqual(["unsettled"]);
    expect(result.warnings[0]?.detail).toContain("cycle 2");
    expect(result.warnings[0]?.detail).not.toContain("cycle 1");
    // A partial failure is noise, not invalidity: the verdict still stands.
    expect(result.supersededVerdict).toBeUndefined();
  });

  it("withdraws a leak verdict when every cycle was observed still moving", () => {
    const result = assessConfidence(input({ settleOutcomes: allWith("moving") }));
    expect(result.supersededVerdict).toBe("inconclusive");
  });

  it("keeps a stable verdict even when no cycle settled", () => {
    const result = assessConfidence(
      input({ settleOutcomes: allWith("moving"), trend: trend({ verdict: "stable" }) })
    );

    // Missing a leak quietly costs the user less than a false accusation, and
    // the warning is still on the report either way.
    expect(result.supersededVerdict).toBeUndefined();
    expect(codesOf(result)).toContain("unsettled");
  });

  // A short --idle-ms cannot fit two GC readings, so stability is never
  // testable. Treating that as a moving heap withdrew every leak found by a
  // fast run — a systematic false negative, caught by the end-to-end test.
  it("says it could not check, rather than overturning the verdict", () => {
    const result = assessConfidence(input({ settleOutcomes: allWith("unknown") }));

    expect(codesOf(result)).toEqual(["settle-unverified"]);
    expect(result.supersededVerdict).toBeUndefined();
    expect(result.warnings[0]?.detail).toContain("too short");
  });

  it("reports moving and unverified cycles separately", () => {
    const outcomes: SettleOutcome[] = [
      { phase: "cycle 1", status: "moving", polls: 9 },
      { phase: "cycle 2", status: "unknown", polls: 1 },
    ];
    const result = assessConfidence(input({ settleOutcomes: outcomes }));

    expect(codesOf(result)).toEqual(["unsettled", "settle-unverified"]);
    // Not every cycle was seen moving, so nothing is withdrawn.
    expect(result.supersededVerdict).toBeUndefined();
  });
});

// "No evidence" must never read as "evidence against". An empty list makes
// every `every()` true and every count match, so the invalidity checks have to
// require that something was actually observed.
describe("absent evidence", () => {
  it("does not withdraw a verdict when no settle data was recorded", () => {
    const result = assessConfidence(input({ settleOutcomes: [] }));

    expect(result.supersededVerdict).toBeUndefined();
    expect(codesOf(result)).toEqual([]);
  });

  it("does not withdraw an abandonment verdict when no load data was recorded", () => {
    const result = assessConfidence(input({ abandonAfterMs: 15, loadOutcomes: [] }));

    expect(result.supersededVerdict).toBeUndefined();
  });

  it("stays quiet about a phase that sent nothing", () => {
    const result = assessConfidence(
      input({ loadOutcomes: [{ phase: "cycle 1", sent: 0, ok2xx: 0 }] })
    );

    // Nothing was sent, so there is no shortfall to report — and no division
    // by zero to render into a percentage.
    expect(codesOf(result)).toEqual([]);
  });
});

describe("load auditing", () => {
  it("accepts exactly 99% of requests landing and warns one request below", () => {
    const at = assessConfidence(
      input({ loadOutcomes: [{ phase: "cycle 1", sent: 1000, ok2xx: 990 }] })
    );
    const below = assessConfidence(
      input({ loadOutcomes: [{ phase: "cycle 1", sent: 1000, ok2xx: 989 }] })
    );

    expect(codesOf(at)).toEqual([]);
    expect(codesOf(below)).toEqual(["load-incomplete"]);
    expect(below.warnings[0]?.detail).toContain("989 of 1000");
    // The share is what makes a shortfall readable at a glance.
    expect(below.warnings[0]?.detail).toContain("98.9%");
  });

  it("does not judge an abandonment run by how many responses completed", () => {
    // Completing few responses is the point of an abandonment run.
    const result = assessConfidence(
      input({
        abandonAfterMs: 15,
        loadOutcomes: [
          { phase: "cycle 1", sent: 1000, ok2xx: 3, abandoned: 997, abandonedMidStream: 500 },
        ],
      })
    );

    expect(codesOf(result)).toEqual([]);
  });
});

// Two shipped implementations of early disconnects abandoned nothing, and both
// produced a verdict identical to the correct one. This is that check.
describe("abandonment auditing", () => {
  it("accepts exactly 90% abandoned and warns one request below", () => {
    const at = assessConfidence(
      input({
        abandonAfterMs: 15,
        loadOutcomes: [{ phase: "cycle 1", sent: 1000, abandoned: 900, abandonedMidStream: 450 }],
      })
    );
    const below = assessConfidence(
      input({
        abandonAfterMs: 15,
        loadOutcomes: [{ phase: "cycle 1", sent: 1000, abandoned: 899 }],
      })
    );

    expect(codesOf(at)).toEqual([]);
    expect(codesOf(below)).toEqual(["abandon-ineffective"]);
    expect(below.warnings[0]?.detail).toContain("899 of 1000");
  });

  it("withdraws a leak verdict when the run abandoned nothing at all", () => {
    const result = assessConfidence(
      input({
        abandonAfterMs: 15,
        loadOutcomes: [
          { phase: "cycle 1", sent: 1000, abandoned: 0 },
          { phase: "cycle 2", sent: 1000, abandoned: 0 },
        ],
      })
    );

    expect(result.supersededVerdict).toBe("inconclusive");
  });

  it("keeps the verdict when at least one cycle did abandon", () => {
    const result = assessConfidence(
      input({
        abandonAfterMs: 15,
        loadOutcomes: [
          { phase: "cycle 1", sent: 1000, abandoned: 0 },
          { phase: "cycle 2", sent: 1000, abandoned: 950, abandonedMidStream: 500 },
        ],
      })
    );

    expect(result.supersededVerdict).toBeUndefined();
    expect(codesOf(result)).toEqual(["abandon-ineffective"]);
  });

  // Under the request origin a cut that lands before the response is the
  // experiment, not a miss. Reporting it would teach the reader to skip the
  // one warning here that still means something.
  it("stays quiet on pre-response cuts when the route asked for them", () => {
    const outcomes = [
      {
        phase: "cycle 1",
        sent: 1000,
        abandoned: 1000,
        abandonedMidStream: 0,
        abandonedBeforeResponse: 1000,
      },
    ];

    const requested = assessConfidence(
      input({ abandonAfterMs: 15, abandonFrom: "request" as const, loadOutcomes: outcomes })
    );
    const byDefault = assessConfidence(input({ abandonAfterMs: 15, loadOutcomes: outcomes }));

    expect(codesOf(requested)).toEqual([]);
    expect(codesOf(byDefault)).toEqual(["abandon-before-response"]);
  });

  it("still reports a shortfall under the request origin", () => {
    const result = assessConfidence(
      input({
        abandonAfterMs: 15,
        abandonFrom: "request" as const,
        loadOutcomes: [
          { phase: "cycle 1", sent: 1000, abandoned: 140, abandonedBeforeResponse: 140 },
        ],
      })
    );

    expect(codesOf(result)).toEqual(["abandon-ineffective"]);
  });
});

describe("growth shape auditing", () => {
  it("accepts a 4x spread between cycles and warns just beyond it", () => {
    const pad = [2 * MB, 2 * MB, 2 * MB];
    const at = assessConfidence(
      input({ trend: trend({ deltas: [1 * MB, 4 * MB, ...pad], growthPerCycle: 2.5 * MB }) })
    );
    const beyond = assessConfidence(
      input({ trend: trend({ deltas: [1 * MB, 4 * MB + 1, ...pad], growthPerCycle: 2.5 * MB }) })
    );

    expect(codesOf(at)).toEqual([]);
    expect(codesOf(beyond)).toEqual(["spiky-growth"]);
  });

  it("ignores spread on a stable verdict, where flat and negative cycles are normal", () => {
    const result = assessConfidence(
      input({ trend: trend({ verdict: "stable", deltas: [1 * KB, 900 * MB], growthPerCycle: 0 }) })
    );

    expect(codesOf(result)).toEqual([]);
  });

  it("flags an uneven inconclusive series too", () => {
    const result = assessConfidence(
      input({
        trend: trend({ verdict: "inconclusive", deltas: [1 * MB, 40 * MB], growthPerCycle: 20 * MB }),
      })
    );

    expect(codesOf(result)).toEqual(["spiky-growth"]);
  });

  it("needs at least two deltas to judge the shape", () => {
    const result = assessConfidence(input({ trend: trend({ deltas: [5 * MB] }) }));
    expect(codesOf(result)).not.toContain("spiky-growth");
  });

  // Spread is only meaningful across a series that grew throughout. With a
  // flat or falling cycle in it, the largest/smallest ratio compares the
  // growing cycles to each other and invents a spike out of ordinary shape.
  it("does not judge spread when any cycle went flat or down", () => {
    const withZero = assessConfidence(
      input({
        trend: trend({ verdict: "inconclusive", deltas: [0, 10 * MB, 100 * MB] }),
      })
    );
    const withNegative = assessConfidence(
      input({
        trend: trend({ verdict: "inconclusive", deltas: [-1 * MB, 10 * MB, 100 * MB] }),
      })
    );

    expect(codesOf(withZero)).toEqual([]);
    expect(codesOf(withNegative)).toEqual([]);
  });
});

describe("noise floor auditing", () => {
  it("accepts growth of exactly twice the threshold and warns one byte below", () => {
    const at = assessConfidence(
      input({
        trend: trend({
          growthPerCycle: 2 * MIN_GROWTH,
          deltas: Array.from({ length: 5 }, () => 2 * MIN_GROWTH),
        }),
      })
    );
    const below = assessConfidence(
      input({
        trend: trend({
          growthPerCycle: 2 * MIN_GROWTH - 1,
          deltas: Array.from({ length: 5 }, () => 2 * MIN_GROWTH - 1),
        }),
      })
    );

    expect(codesOf(at)).toEqual([]);
    expect(codesOf(below)).toEqual(["near-threshold"]);
  });

  it("measures the floor against a custom threshold", () => {
    const result = assessConfidence(
      input({
        minGrowthPerCycle: 4 * MB,
        trend: trend({
          growthPerCycle: 5 * MB,
          deltas: Array.from({ length: 5 }, () => 5 * MB),
        }),
      })
    );

    // 5 MB clears the default floor comfortably but not a 4 MB threshold's.
    expect(codesOf(result)).toEqual(["near-threshold"]);
  });

  it("does not apply the noise floor to a stable verdict", () => {
    const result = assessConfidence(
      input({ trend: trend({ verdict: "stable", growthPerCycle: 1 * KB, deltas: [1 * KB, 0] }) })
    );

    expect(codesOf(result)).toEqual([]);
  });
});

// The measured process runs under an old-space cap. Post-GC retention is not
// distorted by it, but how far the curve was allowed to climb is: a route that
// would have kept growing gets clipped, or dies as an OOM the report blames on
// the app. Nothing used to say the run was near that limit.
describe("heap ceiling audit", () => {
  const samplesPeaking = (peakMb: number): HeapSample[] =>
    [10, peakMb / 2, peakMb].map((heapUsed) => ({
      gcExposed: true,
      heapUsed: heapUsed * MB,
      rss: 3 * heapUsed * MB,
      external: 0,
      arrayBuffers: 0,
    }));

  it("warns when the heap approaches the cap it ran under", () => {
    // The measured vercel/next.js#84884 reproduction: 369 MB under the 512 MB
    // default, 72% of the way to a ceiling nobody was told about.
    const result = assessConfidence(
      input({ memorySamples: samplesPeaking(369), maxOldSpaceMb: 512 })
    );

    expect(codesOf(result)).toEqual(["near-heap-ceiling"]);
    expect(result.warnings[0]?.detail).toContain("512 MB cap");
    expect(result.warnings[0]?.detail).toContain("--max-old-space");
  });

  it("stays quiet when the run had headroom", () => {
    expect(
      codesOf(assessConfidence(input({ memorySamples: samplesPeaking(120), maxOldSpaceMb: 512 })))
    ).toEqual([]);
    // Same absolute peak, a cap that leaves room for it.
    expect(
      codesOf(assessConfidence(input({ memorySamples: samplesPeaking(369), maxOldSpaceMb: 4096 })))
    ).toEqual([]);
  });

  it("does not withdraw the verdict — a clipped leak is still a leak", () => {
    const result = assessConfidence(
      input({ memorySamples: samplesPeaking(500), maxOldSpaceMb: 512 })
    );

    expect(result.supersededVerdict).toBeUndefined();
    expect(effectiveVerdict({ trend: trend(), confidence: result })).toBe("leak");
  });

  it("warns at exactly the ratio, not only past it", () => {
    // 70% of 512 MB. The boundary is the whole decision, so it gets a test:
    // `<` vs `<=` here is the difference between flagging the #84884 shape and
    // waving it through, and nothing else in the suite could tell them apart.
    const atRatio = [{
      gcExposed: true,
      heapUsed: 512 * MB * 0.7,
      rss: 0,
      external: 0,
      arrayBuffers: 0,
    }];
    expect(codesOf(assessConfidence(input({ memorySamples: atRatio, maxOldSpaceMb: 512 })))).toEqual(
      ["near-heap-ceiling"]
    );
  });

  it("names the peak, the cap and the share in the warning", () => {
    const result = assessConfidence(
      input({ memorySamples: samplesPeaking(384), maxOldSpaceMb: 512 })
    );

    // The whole point of the warning is that a reader can judge the headroom
    // for themselves, so all three numbers have to be in it.
    expect(result.warnings[0]?.detail).toContain("384.00 MB");
    expect(result.warnings[0]?.detail).toContain("512 MB cap");
    expect(result.warnings[0]?.detail).toContain("75.0%");
  });

  it("says nothing when the run recorded no cap and no samples", () => {
    expect(codesOf(assessConfidence(input({ memorySamples: samplesPeaking(500) })))).toEqual([]);
    expect(codesOf(assessConfidence(input({ maxOldSpaceMb: 512 })))).toEqual([]);
    // An empty series must be silence by intent, not by `Math.max()` of
    // nothing happening to land on -Infinity.
    expect(codesOf(assessConfidence(input({ memorySamples: [], maxOldSpaceMb: 512 })))).toEqual([]);
  });
});

// Measuring vercel/next.js#94919: 1500/1500 abandoned, 1 of them mid-stream.
// The run looked like a clean test of stream teardown and had not touched it.
// Measured 2026-07-26 on the app from vercel/next.js#94919 with --quick:
// three of nine healthy routes came back `leak`, two with an issue draft, and
// a repeat run disagreed with itself. Three deltas cannot carry an accusation
// unless the growth is far larger than the noise that produced them.
describe("a leak needs evidence proportional to its size", () => {
  const MB = 1024 * 1024;
  const gate = 256 * 1024;

  const leakFrom = (deltas: number[]) => ({
    verdict: "leak" as const,
    growthPerCycle: deltas.reduce((sum, d) => sum + d, 0) / deltas.length,
    deltas,
    source: "heap" as const,
  });

  const audit = (deltas: number[]) =>
    assessConfidence({
      trend: leakFrom(deltas),
      loadOutcomes: [{ phase: "cycle 1", sent: 2000, ok2xx: 2000 }],
      settleOutcomes: [{ phase: "cycle 1", status: "settled", polls: 2 }],
      minGrowthPerCycle: gate,
    });

  it("withdraws /missing, the false positive that shipped an issue draft", () => {
    // The measured series: +3.43, -0.03, +2.76 MB over three deltas.
    const result = audit([3.43 * MB, -0.03 * MB, 2.76 * MB]);
    expect(result.supersededVerdict).toBe("inconclusive");
    expect(codesOf(result)).toContain("thin-evidence");
    expect(
      warrantsIssueDraft({ trend: leakFrom([3.43 * MB, -0.03 * MB, 2.76 * MB]), confidence: result })
    ).toBe(false);
  });

  it("withdraws the other two measured false positives", () => {
    // /product-fail heap and /client-plp external, same run.
    expect(audit([1.41 * MB, 2.78 * MB, 0.61 * MB]).supersededVerdict).toBe("inconclusive");
    expect(audit([1.09 * MB, 2.02 * MB, 0.0]).supersededVerdict).toBe("inconclusive");
  });

  it("leaves #94919 alone: three deltas, but a hundred times the gate", () => {
    const result = audit([25.6 * MB, 25.02 * MB, 24.77 * MB]);
    expect(result.supersededVerdict).toBeUndefined();
    expect(codesOf(result)).not.toContain("thin-evidence");
  });

  it("leaves #95094 alone: a stepwise leak measured over enough cycles", () => {
    // canary.96, six cycles: +12.51, +11.24, +0.10, +16.83, +0.00 MB. Flat
    // cycles are the shape of a stepwise leak; five deltas is the evidence
    // that makes them believable.
    const result = audit([12.51 * MB, 11.24 * MB, 0.1 * MB, 16.83 * MB, 0.0]);
    expect(result.supersededVerdict).toBeUndefined();
  });

  it("accepts modest growth once there are enough cycles to trust it", () => {
    // Same magnitude as the false positives, five deltas instead of three.
    const result = audit([1.4 * MB, 2.8 * MB, 0.6 * MB, 1.2 * MB, 0.9 * MB]);
    expect(result.supersededVerdict).toBeUndefined();
  });

  it("keeps the bundled fixture, which grows every cycle by design", () => {
    // 8 KB retained per request x 300 requests = ~2.4 MB per cycle, on two
    // deltas. Modest against the gate on average, but no cycle gives it back.
    const result = audit([2.4 * MB, 2.3 * MB]);
    expect(result.supersededVerdict).toBeUndefined();
  });

  it("says how many cycles and how far above the gate", () => {
    const detail = audit([3.43 * MB, -0.03 * MB, 2.76 * MB]).warnings.find(
      (warning) => warning.code === "thin-evidence"
    )?.detail;
    expect(detail).toContain("3 cycles");
    expect(detail).toContain("weakest");
    expect(detail).toContain("measure more cycles");
  });

  it("never touches a stable verdict", () => {
    const result = assessConfidence({
      trend: { verdict: "stable", growthPerCycle: 0.1 * MB, deltas: [0.1 * MB, -0.2 * MB], source: "heap" },
      loadOutcomes: [{ phase: "cycle 1", sent: 2000, ok2xx: 2000 }],
      settleOutcomes: [{ phase: "cycle 1", status: "settled", polls: 2 }],
      minGrowthPerCycle: gate,
    });
    expect(result.supersededVerdict).toBeUndefined();
    expect(codesOf(result)).not.toContain("thin-evidence");
  });
});

describe("abandonment reaches the stream", () => {
  it("warns when everything was cut before the server responded", () => {
    const result = assessConfidence(
      input({
        abandonAfterMs: 25,
        loadOutcomes: [
          { phase: "cycle 1", sent: 1500, abandoned: 1500, abandonedMidStream: 1 },
        ],
      })
    );

    expect(codesOf(result)).toEqual(["abandon-before-response"]);
    // The old remedy ("raise abandonAfterMs above time-to-first-byte") was
    // unfollowable under load and is now moot: the deadline starts at the
    // first byte, so landing here means the route never answered.
    expect(result.warnings[0]?.detail).toContain("did not start responding");
    expect(result.warnings[0]?.detail).not.toContain("time-to-first-byte");
  });

  it("stays quiet when a tenth of the abandonments reached mid-stream", () => {
    const result = assessConfidence(
      input({
        abandonAfterMs: 400,
        loadOutcomes: [
          { phase: "cycle 1", sent: 1000, abandoned: 1000, abandonedMidStream: 100 },
        ],
      })
    );

    expect(codesOf(result)).toEqual([]);
  });

  it("reports the shortfall rather than the stream path when little was abandoned", () => {
    const result = assessConfidence(
      input({
        abandonAfterMs: 25,
        loadOutcomes: [{ phase: "cycle 1", sent: 1000, abandoned: 100, abandonedMidStream: 0 }],
      })
    );

    // One diagnosis at a time: nothing was abandoned, so the mid-stream share
    // is not the finding worth reporting.
    expect(codesOf(result)).toEqual(["abandon-ineffective"]);
  });
});

// Measuring a healthy route on a real app produced a leak verdict and, with
// it, a draft accusing Next.js of a leak that did not exist. Re-measured with
// more evidence the same route was plainly stable.
describe("warrantsIssueDraft", () => {
  const report = (verdict: TrendResult["verdict"], codes: string[]) => ({
    trend: trend({ verdict }),
    confidence: {
      level: codes.length === 0 ? ("high" as const) : ("low" as const),
      warnings: codes.map((code) => ({ code, detail: code })) as never,
    },
  });

  it("drafts an issue for a plain leak", () => {
    expect(warrantsIssueDraft(report("leak", []))).toBe(true);
  });

  it("refuses to draft when the growth barely clears the threshold", () => {
    expect(warrantsIssueDraft(report("leak", ["near-threshold"]))).toBe(false);
  });

  it("refuses to draft when one cycle carries the whole average", () => {
    expect(warrantsIssueDraft(report("leak", ["spiky-growth"]))).toBe(false);
  });

  it("still drafts when the warning is about fidelity, not the leak itself", () => {
    // A plain leak found by a run with a short idle budget is still a leak;
    // the caveat travels with the draft.
    expect(warrantsIssueDraft(report("leak", ["settle-unverified"]))).toBe(true);
    expect(warrantsIssueDraft(report("leak", ["abandon-before-response"]))).toBe(true);
  });

  it("never drafts for a verdict that is not a leak", () => {
    expect(warrantsIssueDraft(report("stable", []))).toBe(false);
    expect(warrantsIssueDraft(report("inconclusive", []))).toBe(false);
  });

  it("never drafts for a withdrawn leak", () => {
    expect(
      warrantsIssueDraft({
        trend: trend({ verdict: "leak" }),
        confidence: { level: "low", warnings: [], supersededVerdict: "inconclusive" },
      })
    ).toBe(false);
  });
});

// Warm-up loads modules and warms the JIT — work that does not repeat. On an
// app whose caches key on the request it also fills those caches, and the
// baseline then measures the warm-up instead of the app's resting size.
describe("warm-up baseline contamination", () => {
  const sample = (mb: number): HeapSample => ({
    gcExposed: true,
    heapUsed: mb * 1024 * 1024,
    rss: 3 * mb * 1024 * 1024,
    external: 0,
    arrayBuffers: 0,
  });

  const warnings = (heapMb: number[], warmupRequests?: number) =>
    assessConfidence({
      trend: { verdict: "stable", growthPerCycle: 0, deltas: [] },
      loadOutcomes: [],
      settleOutcomes: [],
      memorySamples: heapMb.map(sample),
      ...(warmupRequests !== undefined && { warmupRequests }),
    }).warnings.filter((warning) => warning.code === "warm-up-baseline");

  it("flags the measured #97424 shape", () => {
    // Baseline 861.7 MB against 129.4 MB on the very next cycle: 85% of the
    // baseline was warm-up, and every delta was measured from that start.
    const found = warnings([861.7, 129.4, 253.0, 179.1, 107.1, 184.1, 235.5], 200);

    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("861.70 MB");
    expect(found[0]?.detail).toContain("129.40 MB");
    expect(found[0]?.detail).toContain("200 warm-up requests");
    expect(found[0]?.detail).toContain("--warmup");
  });

  it("stays quiet on a healthy app", () => {
    // 7.3 → 7.1 MB: 3% of the baseline, and 0.2 MB in absolute terms.
    expect(warnings([7.3, 7.1, 7.1, 7.2, 7.2, 7.2, 7.3])).toHaveLength(0);
  });

  it("stays quiet on the #96533 app, which drops 3% of 27 MB", () => {
    expect(warnings([27.1, 26.3, 27.3, 27.6, 27.8, 27.8, 27.9])).toHaveLength(0);
  });

  it("stays quiet when a small app sheds most of a small baseline", () => {
    // 80% of 10 MB is still only 8 MB — nothing worth re-running for.
    expect(warnings([10, 2, 2.1, 2.2, 2.3])).toHaveLength(0);
  });

  it("stays quiet when the baseline is below the first cycle", () => {
    // The ordinary shape: warm-up costs a little and the app grows into it.
    expect(warnings([29.4, 31.5, 32.3, 32.1])).toHaveLength(0);
  });

  it("does not weaken the verdict or block an issue draft", () => {
    // It is a statement about where the baseline sat, not about whether the
    // evidence supports the verdict.
    const report = assessConfidence({
      trend: { verdict: "leak", growthPerCycle: 40 * 1024 * 1024, deltas: [40e6, 41e6, 42e6, 43e6, 44e6] },
      loadOutcomes: [],
      settleOutcomes: [],
      memorySamples: [861.7, 129.4, 253.0, 179.1, 107.1, 184.1, 235.5].map(sample),
    });

    expect(report.warnings.some((warning) => warning.code === "warm-up-baseline")).toBe(true);
    expect(report.supersededVerdict).toBeUndefined();
    expect(warrantsIssueDraft({ trend: { verdict: "leak", growthPerCycle: 0, deltas: [] }, confidence: report })).toBe(true);
  });
});

// `saturating` is a finding, not an accusation: the curve bends, which is what
// a bounded store does. Drafting an issue from one would file a cache.
describe("drafts and the saturating verdict", () => {
  it("does not warrant an issue draft", () => {
    const report = {
      trend: { verdict: "saturating" as const, growthPerCycle: 4 * 1024 * 1024, deltas: [] },
      confidence: { level: "high" as const, warnings: [] },
    };
    expect(warrantsIssueDraft(report)).toBe(false);
  });

  it("still warrants one for a leak on a cache-driven route, which the draft must disclose", () => {
    const report = {
      trend: {
        verdict: "leak" as const,
        growthPerCycle: 4 * 1024 * 1024,
        deltas: [],
        cacheDriven: true as const,
      },
      confidence: { level: "high" as const, warnings: [] },
    };
    expect(warrantsIssueDraft(report)).toBe(true);
  });
});
