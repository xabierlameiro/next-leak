import { describe, expect, it } from "vitest";
import { gapCause, gapCauseOfMany } from "./attribution-gap.js";

describe("gapCause", () => {
  it("names each reason", () => {
    expect(gapCause("snapshot-unavailable")).toBe("the final heap snapshot was never taken");
    expect(gapCause("snapshot-unreadable")).toBe("the heap snapshots could not be read");
    expect(gapCause("interrupted")).toBe(
      "the run was interrupted before the heap snapshots were compared (both are on disk)"
    );
  });
});

describe("gapCauseOfMany", () => {
  it("names each distinct reason once, in the order met", () => {
    expect(gapCauseOfMany(["snapshot-unreadable", "snapshot-unreadable"])).toBe(
      "their snapshot could not be read"
    );
    expect(gapCauseOfMany(["snapshot-unavailable", "interrupted", "snapshot-unavailable"])).toBe(
      "their final snapshot could not be taken, or the run was interrupted before their snapshots were compared"
    );
  });
});
