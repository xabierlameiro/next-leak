import { describe, expect, it } from "vitest";
import { HELD_FLOOR_BYTES, nodeComparisonText, nodeVersionsDiffer } from "./node-comparison.js";
import type { NodeVersionResult } from "./runner.js";

const MB = 1024 * 1024;
const result = (version: string, verdict: NodeVersionResult["verdict"], heldMb?: number): NodeVersionResult => ({
  version,
  status: "measured",
  ...(verdict !== undefined && { verdict }),
  ...(heldMb !== undefined && { heldBytes: heldMb * MB }),
});

describe("nodeVersionsDiffer", () => {
  // vercel/next.js#97938, 16.3.6: both stable, one holding ~750 MB.
  it("calls two stable versions far apart in memory different", () => {
    expect(nodeVersionsDiffer([result("v22.23.5", "stable", 747), result("v24.22.3", "stable", 48)])).toBe(true);
  });

  it("calls versions that agree on verdict and memory the same", () => {
    expect(nodeVersionsDiffer([result("v22", "stable", 48), result("v24", "stable", 52)])).toBe(false);
  });

  it("calls different verdicts different", () => {
    expect(nodeVersionsDiffer([result("v22", "leak", 48), result("v24", "stable", 48)])).toBe(true);
  });

  it("calls a version that did not measure different from one that did", () => {
    expect(
      nodeVersionsDiffer([result("v22", "stable", 48), { version: "v24", status: "failed" }])
    ).toBe(true);
  });

  it("needs both the ratio and the floor", () => {
    // 2x but only 30 MiB apart; 64 MiB apart but only 1.1x.
    expect(nodeVersionsDiffer([result("a", "stable", 30), result("b", "stable", 60)])).toBe(false);
    expect(nodeVersionsDiffer([result("a", "stable", 640), result("b", "stable", 704)])).toBe(false);
    // Exactly at both.
    const floorMb = HELD_FLOOR_BYTES / MB;
    expect(nodeVersionsDiffer([result("a", "stable", floorMb), result("b", "stable", 2 * floorMb)])).toBe(true);
    expect(
      nodeVersionsDiffer([result("a", "stable", floorMb + 1), result("b", "stable", 2 * floorMb)])
    ).toBe(false);
  });

  it("cannot compare memory when only one version reported it", () => {
    expect(nodeVersionsDiffer([result("a", "stable", 700), result("b", "stable")])).toBe(false);
  });
});

describe("nodeComparisonText", () => {
  it("lists each version with what it held, and flags a difference", () => {
    expect(
      nodeComparisonText([result("v22.23.5", "stable", 747.5), result("v24.22.3", "stable", 48)])
    ).toBe(
      "by Node version: v22.23.5 stable, holds 747.5 MB · v24.22.3 stable, holds 48.0 MB — the versions differ"
    );
  });

  it("says nothing extra when they agree", () => {
    expect(nodeComparisonText([result("v22", "stable", 48), result("v24", "stable", 52)])).toBe(
      "by Node version: v22 stable, holds 48.0 MB · v24 stable, holds 52.0 MB"
    );
  });

  it("names the status of a version that did not measure", () => {
    expect(
      nodeComparisonText([result("v22", "stable"), { version: "v24", status: "died-of-heap" }])
    ).toBe("by Node version: v22 stable · v24 died-of-heap — the versions differ");
  });

  it("is absent without a comparison", () => {
    expect(nodeComparisonText(undefined)).toBeNull();
    expect(nodeComparisonText([result("v22", "stable", 48)])).toBeNull();
  });
});
