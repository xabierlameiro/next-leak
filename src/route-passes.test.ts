import { describe, expect, it } from "vitest";
import type { WarningCode } from "./confidence.js";
import { confirmationFor } from "./route-passes.js";
import { makeRunReport } from "./run-report.fixture.js";
import type { MeasuredRoute } from "./run-types.js";
import type { TrendVerdict } from "./trend.js";

function measured(verdict: TrendVerdict, codes: WarningCode[]): MeasuredRoute {
  const base = makeRunReport().routes.find((route) => route.status === "measured");
  if (base?.status !== "measured") throw new Error("fixture has no measured route");
  return {
    ...base,
    trend: { ...base.trend, verdict },
    confidence: {
      level: codes.length === 0 ? "high" : "low",
      warnings: codes.map((code) => ({ code, detail: code })),
    },
  };
}

describe("confirmationFor", () => {
  it.each<WarningCode>([
    "unsettled",
    "settle-unverified",
    "load-incomplete",
    "spiky-growth",
    "near-threshold",
    "thin-evidence",
    "warm-up-baseline",
    "first-cycle-step",
  ])("confirms a stable whose sample carries %s, within the budget", (code) => {
    expect(confirmationFor(measured("stable", [code]))).toEqual({
      reason: `low confidence (${code})`,
      budgeted: true,
    });
  });

  it.each<WarningCode>([
    "abandon-ineffective",
    "abandon-before-response",
    "near-heap-ceiling",
    "cache-residency",
    "repetitions-disagree",
  ])("leaves %s alone: a second run of the same experiment cannot change it", (code) => {
    expect(confirmationFor(measured("stable", [code]))).toBeNull();
  });

  it("confirms leak and saturating too, but not pressure", () => {
    expect(confirmationFor(measured("saturating", ["unsettled"]))?.budgeted).toBe(true);
    expect(confirmationFor(measured("leak", ["unsettled"]))?.budgeted).toBe(true);
    expect(confirmationFor(measured("pressure", ["unsettled"]))).toBeNull();
  });

  it("names every warning that earned it", () => {
    expect(confirmationFor(measured("stable", ["unsettled", "cache-residency", "spiky-growth"]))?.reason).toBe(
      "low confidence (unsettled, spiky-growth)"
    );
  });

  it("confirms a borderline leak outside the budget", () => {
    expect(confirmationFor(measured("leak", ["near-threshold", "spiky-growth"]))).toEqual({
      reason: "its growth barely clears the threshold",
      budgeted: false,
    });
  });

  it("does not confirm a clean verdict", () => {
    expect(confirmationFor(measured("leak", []))).toBeNull();
    expect(confirmationFor(measured("stable", []))).toBeNull();
  });
});
