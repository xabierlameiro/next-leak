import { describe, expect, it } from "vitest";
import { decodeMappings, decodeVlqLine, sourceIndexAt } from "./vlq.js";

describe("decodeVlqLine", () => {
  it("decodes canonical single-digit values", () => {
    // A=0, C=1, D=-1, E=2 in base64 VLQ.
    expect(decodeVlqLine("AAAA")).toEqual([[0, 0, 0, 0]]);
    expect(decodeVlqLine("CADE")).toEqual([[1, 0, -1, 2]]);
  });

  it("decodes continuation values", () => {
    // 'gB' = continuation(0) + 1<<5 → 32 → value 16.
    expect(decodeVlqLine("gB")).toEqual([[16]]);
  });

  it("splits comma-separated segments", () => {
    expect(decodeVlqLine("A,C")).toEqual([[0], [1]]);
  });

  it("rejects invalid characters", () => {
    expect(() => decodeVlqLine("!")).toThrow("invalid VLQ character");
  });
});

describe("decodeMappings + sourceIndexAt", () => {
  it("tracks columns per line and source indices across lines", () => {
    // Line 0: segment at col 0 → source 0; segment at col 16 → source 1.
    // Line 1: segment at col 2 → source stays 1.
    const lines = decodeMappings("AAAA,gBCAA;EAAA");
    expect(sourceIndexAt(lines, 0, 0)).toBe(0);
    expect(sourceIndexAt(lines, 0, 15)).toBe(0);
    expect(sourceIndexAt(lines, 0, 16)).toBe(1);
    expect(sourceIndexAt(lines, 0, 500)).toBe(1);
    expect(sourceIndexAt(lines, 1, 2)).toBe(1);
    expect(sourceIndexAt(lines, 9, 0)).toBeUndefined();
  });
});
