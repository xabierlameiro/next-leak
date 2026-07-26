import { describe, expect, it } from "vitest";
import { requestGc, requestMemory } from "./control-client.js";

// The control channel's failures reach users verbatim inside route reports.
// A bare "fetch failed" reads like a bug in this tool; the error must say
// which channel, which operation, and what that usually means.
describe("control channel errors", () => {
  it("names the operation and the likely cause when nothing answers", async () => {
    // A port nothing listens on: the same shape as a measured process that
    // died or whose event loop is blocked mid-snapshot.
    await expect(requestGc(1)).rejects.toThrow(/control channel \/gc on port 1/);
    await expect(requestGc(1)).rejects.toThrow(/gone or its event loop is blocked/);
    await expect(requestMemory(1)).rejects.toThrow(/\/mem/);
  });
});
