import { createRequire } from "node:module";
import os from "node:os";

const require = createRequire(import.meta.url);
const { version: nextLeakVersion } = require("../package.json") as { version: string };

export type MeasurementEnvironment = {
  /** The Node that ran the measured server: the first `--node` binary, or next-leak's own. */
  nodeVersion: string;
  /** Every version measured, in order, when a run compared several. */
  comparedNodeVersions?: string[];
  platform: string;
  arch: string;
  cpuModel: string | null;
  totalMemoryBytes: number;
  /** The container's memory limit, when one applies below physical memory. */
  memoryLimitBytes?: number;
  nextVersion: string | null;
  nextLeakVersion: string;
};

/** A report without environment info is not reproducible — capture it once per run. */
export function captureEnvironment(
  nextVersion: string | null,
  serverNodeVersions: readonly string[] = [],
  limitBytes: number | null = memoryLimitBytes()
): MeasurementEnvironment {
  return {
    nodeVersion: serverNodeVersions[0] ?? process.version,
    ...(serverNodeVersions.length > 1 && { comparedNodeVersions: [...serverNodeVersions] }),
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? null,
    totalMemoryBytes: os.totalmem(),
    ...withMemoryLimit(limitBytes),
    nextVersion,
    nextLeakVersion,
  };
}

function withMemoryLimit(limit: number | null): { memoryLimitBytes?: number } {
  return limit === null ? {} : { memoryLimitBytes: limit };
}

const MB = 1024 * 1024;

/**
 * Memory a measured process uses outside old space: young generation, code,
 * native buffers, the compiler's own. A guess on the safe side.
 */
export const HEADROOM_PER_PROCESS_MB = 256;

/** Smallest cap worth suggesting; below it the app will not boot. */
const MIN_SUGGESTED_CAP_MB = 128;

/**
 * The memory limit this process runs under, or null when there is none.
 *
 * `process.constrainedMemory()` reads cgroup v1 and v2. It returns 0, or a
 * value at or above physical memory, when nothing limits the process. The
 * measured server is a child in the same cgroup, so the same limit applies.
 */
export function memoryLimitBytes(): number | null {
  return memoryLimitFrom(process.constrainedMemory?.(), os.totalmem());
}

/** The limit from what Node reported, null when it is no limit at all. */
export function memoryLimitFrom(constrained: number | undefined, total: number): number | null {
  // 0, NaN and Infinity all fail one of the two comparisons.
  const value = constrained ?? 0;
  return value > 0 && value < total ? value : null;
}

/**
 * Says so when the container cannot hold the heap cap.
 *
 * The cap is a ceiling only if the process can reach it. Under a smaller
 * limit the kernel kills the server first, and a route that should end in
 * `pressure` ends in a crash. `next dev` runs a CLI parent next to the fork
 * that renders, both under the cap through `NODE_OPTIONS`; the parent stays
 * small, so it costs one more allowance, not another cap.
 */
export function memoryLimitWarning(input: {
  limitBytes: number | null;
  maxOldSpaceMb: number;
  dev: boolean;
}): string | null {
  if (input.limitBytes === null) {
    return null;
  }
  const limitMb = Math.floor(input.limitBytes / MB);
  const headroomMb = HEADROOM_PER_PROCESS_MB * (input.dev ? 2 : 1);
  if (input.maxOldSpaceMb + headroomMb <= limitMb) {
    return null;
  }
  const fits = Math.floor((limitMb - headroomMb) / 64) * 64;
  const advice =
    fits >= MIN_SUGGESTED_CAP_MB
      ? `pass --max-old-space ${fits} or raise the container limit`
      : "raise the container limit";
  return (
    `memory limit ${limitMb} MB cannot hold --max-old-space-size=${input.maxOldSpaceMb} ` +
    `plus ${headroomMb} MB outside the heap: the server may be killed before it reaches ` +
    `its cap, and a route under pressure would read as a crash — ${advice}`
  );
}
