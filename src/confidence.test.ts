import { describe, expect, it } from "vitest";
import {
  assessConfidence,
  warrantsIssueDraft,
  type ConfidenceInput,
} from "./confidence.js";
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
});

describe("growth shape auditing", () => {
  it("accepts a 4x spread between cycles and warns just beyond it", () => {
    const at = assessConfidence(
      input({ trend: trend({ deltas: [1 * MB, 4 * MB], growthPerCycle: 2.5 * MB }) })
    );
    const beyond = assessConfidence(
      input({ trend: trend({ deltas: [1 * MB, 4 * MB + 1], growthPerCycle: 2.5 * MB }) })
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
          deltas: [2 * MIN_GROWTH, 2 * MIN_GROWTH],
        }),
      })
    );
    const below = assessConfidence(
      input({
        trend: trend({
          growthPerCycle: 2 * MIN_GROWTH - 1,
          deltas: [2 * MIN_GROWTH - 1, 2 * MIN_GROWTH - 1],
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
        trend: trend({ growthPerCycle: 5 * MB, deltas: [5 * MB, 5 * MB] }),
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

// Measuring vercel/next.js#94919: 1500/1500 abandoned, 1 of them mid-stream.
// The run looked like a clean test of stream teardown and had not touched it.
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
    expect(result.warnings[0]?.detail).toContain("time-to-first-byte");
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
