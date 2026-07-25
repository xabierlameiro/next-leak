import { describe, expect, it } from "vitest";
import { assessPeakPressure, describePeakPressure } from "./peak-pressure.js";
import type { PeakSample } from "./ritual.js";

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
