import path from "node:path";
import { attributeDiff, type AttributedDiff } from "./attribution.js";
import type { BuildRunResult } from "./build-run.js";
import { bracketedShare } from "./build-snapshot.js";
import { diffSnapshotFiles, SnapshotError, type HeapDiff } from "./heap-diff.js";
import { extractModuleRegistry } from "./module-registry.js";

export type BuildAttribution = {
  diff: HeapDiff;
  attributed: AttributedDiff;
  /** Modules the registry resolved. Zero means every finding stays unattributed. */
  registrySize: number;
  /** Share of the worker's observed growth the snapshot pair spans, 0 to 1. */
  bracketed: number;
  baselineRssBytes: number;
  afterRssBytes: number;
  /** Where the pair was stored, so the finding can be checked by hand. */
  baselineFile: string;
  afterFile: string;
};

export type BuildAttributionDeps = {
  diff: typeof diffSnapshotFiles;
  registry: typeof extractModuleRegistry;
};

const defaultDeps: BuildAttributionDeps = {
  diff: diffSnapshotFiles,
  registry: extractModuleRegistry,
};

/**
 * Names what a build's worker retained, from the pair the run captured.
 *
 * Returns null rather than throwing on every failure path. A build measurement
 * stands on its curve and its verdict; this is an addition to the report, and
 * an addition that can fail must not be able to take the report with it.
 *
 * The registry is read from `.next/server` *after* the build, never during it:
 * a half-written chunk can resolve a module id to the wrong source, and naming
 * the wrong owner confidently is worse than naming none.
 */
export async function attributeBuildCapture(
  result: BuildRunResult,
  appDir: string,
  onProgress: (message: string) => void = () => {},
  deps: BuildAttributionDeps = defaultDeps
): Promise<BuildAttribution | null> {
  const capture = result.capture;
  if (capture === null) {
    return null;
  }
  onProgress(`diffing what worker ${capture.pid} retained`);
  let diff: HeapDiff;
  try {
    diff = await deps.diff(capture.files.baselineFile, capture.files.afterFile);
  } catch (cause) {
    onProgress(
      cause instanceof SnapshotError
        ? `no attribution: ${cause.message}`
        : `no attribution: the snapshot pair could not be diffed`
    );
    return null;
  }
  const registry = await deps.registry(path.join(appDir, ".next", "server"));
  return {
    diff,
    attributed: attributeDiff(diff, registry),
    registrySize: registry.size,
    // Against the captured worker's own peak. `result.peakWorkerRssBytes` is
    // the highest of every worker, which on a multi-worker build can belong to
    // a process these findings say nothing about.
    bracketed: bracketedShare(
      capture.baselineRssBytes,
      capture.afterRssBytes,
      capture.peakRssBytes
    ),
    baselineRssBytes: capture.baselineRssBytes,
    afterRssBytes: capture.afterRssBytes,
    baselineFile: capture.files.baselineFile,
    afterFile: capture.files.afterFile,
  };
}
