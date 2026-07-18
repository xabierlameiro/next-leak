import { createRequire } from "node:module";
import os from "node:os";

const require = createRequire(import.meta.url);
const { version: nextLeakVersion } = require("../package.json") as { version: string };

export type MeasurementEnvironment = {
  nodeVersion: string;
  platform: string;
  arch: string;
  cpuModel: string | null;
  totalMemoryBytes: number;
  nextVersion: string | null;
  nextLeakVersion: string;
};

/** A report without environment info is not reproducible — capture it once per run. */
export function captureEnvironment(nextVersion: string | null): MeasurementEnvironment {
  return {
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? null,
    totalMemoryBytes: os.totalmem(),
    nextVersion,
    nextLeakVersion,
  };
}
