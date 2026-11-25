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
  nextVersion: string | null;
  nextLeakVersion: string;
};

/** A report without environment info is not reproducible — capture it once per run. */
export function captureEnvironment(
  nextVersion: string | null,
  serverNodeVersions: readonly string[] = []
): MeasurementEnvironment {
  return {
    nodeVersion: serverNodeVersions[0] ?? process.version,
    ...(serverNodeVersions.length > 1 && { comparedNodeVersions: [...serverNodeVersions] }),
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? null,
    totalMemoryBytes: os.totalmem(),
    nextVersion,
    nextLeakVersion,
  };
}
