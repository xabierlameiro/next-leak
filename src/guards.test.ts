import { describe, expect, it } from "vitest";
import { checkRuntime } from "./guards.js";

describe("checkRuntime", () => {
  it("passes on supported platforms", () => {
    expect(checkRuntime({ nodeMajor: 22, platform: "darwin" })).toBeNull();
    expect(checkRuntime({ nodeMajor: 24, platform: "linux" })).toBeNull();
  });

  it("rejects old Node with an actionable message", () => {
    const message = checkRuntime({ nodeMajor: 18, platform: "linux" });
    expect(message).toContain("Node.js >= 22");
    expect(message).toContain("Upgrade");
  });

  it("rejects Windows pointing at WSL2", () => {
    const message = checkRuntime({ nodeMajor: 22, platform: "win32" });
    expect(message).toContain("Windows");
    expect(message).toContain("WSL2");
  });
});

describe("checkRuntime with the real process", () => {
  it("passes on the runtime running these tests (Node >= 22, not Windows)", () => {
    // Exercises the un-injected path that reads process facts directly.
    expect(checkRuntime()).toBeNull();
  });
});
