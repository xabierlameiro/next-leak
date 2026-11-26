import { describe, expect, it } from "vitest";
import { observedThroughput, paceNote, passSecondsAt } from "./eta.js";

// vercel/next.js#97938 slug route, 16.3.6 on Node 22: the first pass of a run
// announced at "26s–47s".
const SLUG_PASS = [
  { phase: "warm-up", seconds: 2 },
  { phase: "baseline snapshot", seconds: 2.1 },
  { phase: "cycle 1 load", seconds: 47.1 },
  { phase: "cycle 1 unreclaimed read", seconds: 2 },
  { phase: "cycle 1 settle", seconds: 4.6 },
  { phase: "cycle 2 load", seconds: 48.3 },
  { phase: "cycle 2 unreclaimed read", seconds: 2 },
  { phase: "cycle 2 settle", seconds: 4.6 },
  { phase: "after snapshot", seconds: 17.9 },
];

describe("observedThroughput", () => {
  it("is requests over load seconds, cycles only", () => {
    expect(observedThroughput(SLUG_PASS, 300)).toBeCloseTo(600 / 95.4);
  });

  it("is null without a load phase, or with loads that took no time", () => {
    expect(observedThroughput([{ phase: "warm-up", seconds: 2 }], 300)).toBeNull();
    expect(observedThroughput([{ phase: "cycle 1 load", seconds: 0 }], 300)).toBeNull();
  });

  it("does not count a phase that only mentions load", () => {
    const timings = [
      { phase: "cycle 1 load", seconds: 10 },
      { phase: "cycle 1 settle", seconds: 10 },
      { phase: "warm-up load", seconds: 10 },
    ];
    expect(observedThroughput(timings, 100)).toBe(10);
  });
});

describe("passSecondsAt", () => {
  it("keeps the fixed phases and scales the mean cycle", () => {
    // Fixed 22 s; two cycles of 53.7 and 54.9 s, mean 54.3.
    expect(passSecondsAt(SLUG_PASS, 8)).toBeCloseTo(22 + 8 * 54.3);
    expect(passSecondsAt(SLUG_PASS, 2)).toBeCloseTo(22 + 2 * 54.3);
  });

  it("tells cycle 1 from cycle 11, and a cycle from a phase that only names one", () => {
    const timings = [
      { phase: "warm-up cycle 1 note", seconds: 5 },
      ...Array.from({ length: 11 }, (_, index) => ({ phase: `cycle ${index + 1} load`, seconds: 10 })),
    ];
    // 11 cycles of 10 s; the warm-up line is fixed time, not a twelfth cycle.
    expect(passSecondsAt(timings, 22)).toBe(5 + 22 * 10);
  });

  it("is null without a cycle to go by", () => {
    expect(passSecondsAt([{ phase: "warm-up", seconds: 2 }], 8)).toBeNull();
    expect(passSecondsAt([], 8)).toBeNull();
  });
});

describe("paceNote", () => {
  it("rounds and formats, or says nothing", () => {
    expect(paceNote(456.4, "at the pace of the first pass")).toBe(
      " (≈ 8m at the pace of the first pass)"
    );
    expect(paceNote(44.6, "basis")).toBe(" (≈ 45s basis)");
    expect(paceNote(null, "basis")).toBe("");
  });
});
