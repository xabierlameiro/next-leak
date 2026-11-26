import os from "node:os";
import { describe, expect, it } from "vitest";
import { captureEnvironment, memoryLimitBytes, memoryLimitFrom, memoryLimitWarning } from "./environment.js";

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

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("memoryLimitFrom", () => {
  it("is null when Node reports no limit", () => {
    expect(memoryLimitFrom(undefined, 32 * GB)).toBeNull();
    expect(memoryLimitFrom(0, 32 * GB)).toBeNull();
    expect(memoryLimitFrom(Number.POSITIVE_INFINITY, 32 * GB)).toBeNull();
    expect(memoryLimitFrom(Number.NaN, 32 * GB)).toBeNull();
    expect(memoryLimitFrom(-1, 32 * GB)).toBeNull();
  });

  it("is null when the limit is not below physical memory", () => {
    // cgroup v1 without a limit reports 2^63 - 4096.
    expect(memoryLimitFrom(2 ** 63, 32 * GB)).toBeNull();
    expect(memoryLimitFrom(32 * GB, 32 * GB)).toBeNull();
  });

  it("is the limit when it is below physical memory", () => {
    expect(memoryLimitFrom(2 * GB, 32 * GB)).toBe(2 * GB);
  });

  it("is recorded in the environment only when there is one", () => {
    expect(captureEnvironment(null, [], 2 * GB).memoryLimitBytes).toBe(2 * GB);
    expect(captureEnvironment(null, [], null)).not.toHaveProperty("memoryLimitBytes");
  });
});

describe("memoryLimitBytes", () => {
  it("reads what Node reports for this process", () => {
    expect(memoryLimitBytes()).toBe(memoryLimitFrom(process.constrainedMemory(), os.totalmem()));
  });
});

describe("memoryLimitWarning", () => {
  it("says nothing without a limit", () => {
    expect(memoryLimitWarning({ limitBytes: null, maxOldSpaceMb: 512, dev: false })).toBeNull();
  });

  it("says nothing when the cap and 256 MB fit, exactly or with room", () => {
    expect(memoryLimitWarning({ limitBytes: 768 * MB, maxOldSpaceMb: 512, dev: false })).toBeNull();
    expect(memoryLimitWarning({ limitBytes: 2 * GB, maxOldSpaceMb: 512, dev: true })).toBeNull();
  });

  it("names the limit and the cap, and a cap that fits", () => {
    const warning = memoryLimitWarning({ limitBytes: 512 * MB, maxOldSpaceMb: 512, dev: false });
    expect(warning).toContain("memory limit 512 MB");
    expect(warning).toContain("--max-old-space-size=512");
    expect(warning).toContain("plus 256 MB");
    expect(warning).toContain("pass --max-old-space 256 or raise the container limit");
  });

  it("warns one byte over the line", () => {
    expect(
      memoryLimitWarning({ limitBytes: 768 * MB - 1, maxOldSpaceMb: 512, dev: false })
    ).not.toBeNull();
  });

  it("counts the next dev parent as one more allowance", () => {
    expect(memoryLimitWarning({ limitBytes: 1 * GB, maxOldSpaceMb: 512, dev: false })).toBeNull();
    const warning = memoryLimitWarning({ limitBytes: 1 * GB, maxOldSpaceMb: 768, dev: true });
    expect(warning).toContain("plus 512 MB");
    expect(warning).toContain("pass --max-old-space 512");
  });

  it("rounds the suggested cap down to 64 MB", () => {
    const warning = memoryLimitWarning({ limitBytes: 1000 * MB, maxOldSpaceMb: 1024, dev: false });
    expect(warning).toContain("pass --max-old-space 704");
  });

  it("only asks for a larger container when no useful cap fits", () => {
    const warning = memoryLimitWarning({ limitBytes: 383 * MB, maxOldSpaceMb: 512, dev: false });
    expect(warning).toContain("— raise the container limit");
    expect(warning).not.toContain("pass --max-old-space");
    expect(
      memoryLimitWarning({ limitBytes: 384 * MB, maxOldSpaceMb: 512, dev: false })
    ).toContain("pass --max-old-space 128");
  });
});
