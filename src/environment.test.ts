import os from "node:os";
import { describe, expect, it } from "vitest";
import { captureEnvironment } from "./environment.js";

// Two mutants survived here for want of any direct test: the cpuModel
// fallback could be forced to null, hiding the CPU from every report and
// issue draft that quotes it.
describe("captureEnvironment", () => {
  it("captures the real machine, not placeholders", () => {
    const environment = captureEnvironment("16.2.2");
    expect(environment.nodeVersion).toBe(process.version);
    expect(environment.platform).toBe(os.platform());
    expect(environment.arch).toBe(os.arch());
    // Every machine this runs on has at least one CPU with a model string.
    expect(environment.cpuModel).toBe(os.cpus()[0]?.model);
    expect(environment.cpuModel).not.toBeNull();
    expect(environment.totalMemoryBytes).toBe(os.totalmem());
    expect(environment.nextVersion).toBe("16.2.2");
    expect(environment.nextLeakVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
