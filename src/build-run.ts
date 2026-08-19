import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  collectSnapshotPair,
  decideCapture,
  discardSnapshots,
  type CaptureStage,
  type CollectedPair,
} from "./build-snapshot.js";
import { validateBuildTarget } from "./build-target.js";
import {
  classifyBuildSamples,
  diedOfHeapExhaustion,
  netGrowthOf,
  pagesGeneratedFrom,
  retentionPerPage,
  strippedHeapCap,
  type BuildSample,
} from "./build-verdict.js";
import { registerChild, unregisterChild } from "./launcher.js";
import {
  descendantsOf,
  isStaticGenWorker,
  sampleProcessTable,
  type ProcessRow,
  type ProcessTableSample,
} from "./process-tree.js";
import type { TrendResult } from "./trend.js";

/** How often the process tree is sampled while the build runs. */
const POLL_MS = 500;

export type WorkerSeries = {
  pid: number;
  samples: BuildSample[];
};

export type BuildCapture = {
  pid: number;
  files: CollectedPair;
  baselineRssBytes: number;
  afterRssBytes: number;
};

export type BuildRunResult = {
  appDir: string;
  /**
   * `measured` carries a verdict. `build-failed` means the build broke for a
   * reason that is not memory, and makes no memory claim. `nothing-to-measure`
   * means no static-generation worker ever ran. `cannot-sample` means the
   * process table could not be read, which is not the same as finding nothing
   * in it.
   */
  status: "measured" | "build-failed" | "nothing-to-measure" | "cannot-sample";
  /** Why sampling stopped, when it did. */
  samplingFailure: string | null;
  verdict: TrendResult["verdict"] | null;
  trend: TrendResult | null;
  /** Segmented levels the verdict was read from, in bytes. */
  levels: number[];
  workers: WorkerSeries[];
  /** The build's own process, reported but never judged: it sheds while workers climb. */
  parentSamples: BuildSample[];
  peakWorkerRssBytes: number;
  netGrowthBytes: number;
  pagesGenerated: number | null;
  retentionPerPageBytes: number | null;
  /** True when a worker hit the V8 heap limit — the finding, not a failure. */
  heapExhausted: boolean;
  /**
   * The snapshot pair captured from a worker, when one was. Attribution is an
   * addition to this report, never a precondition for it: every field above is
   * produced whether or not capture worked.
   */
  capture: BuildCapture | null;
  strippedCapWarning: string | null;
  exitCode: number | null;
  output: string;
};

export type BuildRunOptions = {
  appDir: string;
  /** Where a captured snapshot pair is moved to. Capture is skipped without it. */
  workDir?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Overrides `process.env` for the build. */
  env?: NodeJS.ProcessEnv;
};

export type BuildRunDeps = {
  spawnBuild: (appDir: string, env: NodeJS.ProcessEnv) => ChildProcess;
  signalWorker: (pid: number) => void;
  sampleTable: () => Promise<ProcessTableSample>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/**
 * Runs Next's own binary rather than `npm run build`.
 *
 * A package-manager wrapper adds two processes between the run and the build
 * for nothing, and it makes the tree depend on which manager the project uses.
 * Going straight at the bin keeps the tree short and the same everywhere.
 */
function spawnNextBuild(appDir: string, env: NodeJS.ProcessEnv): ChildProcess {
  const nextBin = path.join(appDir, "node_modules", "next", "dist", "bin", "next");
  return spawn(process.execPath, [nextBin, "build"], {
    cwd: appDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * SIGUSR2 is what `--heapsnapshot-signal` listens for. Verified on a live
 * static-generation worker: signalled at 73% of its heap cap it still finished
 * the build, so this does not have to be done timidly.
 */
const signalWorker = (pid: number): void => {
  try {
    process.kill(pid, "SIGUSR2");
  } catch {
    // The worker finished between the poll and the signal. Not a failure:
    // capture is optional and the run says so when no pair arrives.
  }
};

const defaultDeps: BuildRunDeps = {
  spawnBuild: spawnNextBuild,
  signalWorker,
  sampleTable: sampleProcessTable,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Collects one poll's readings into the per-PID series. */
function recordSample(
  rows: readonly ProcessRow[],
  rootPid: number,
  atMs: number,
  workers: Map<number, BuildSample[]>,
  parentSamples: BuildSample[]
): void {
  const root = rows.find((row) => row.pid === rootPid);
  if (root !== undefined) {
    parentSamples.push({ atMs, rssBytes: root.rssBytes });
  }
  for (const row of descendantsOf(rows, rootPid)) {
    if (!isStaticGenWorker(row)) {
      continue;
    }
    const series = workers.get(row.pid) ?? [];
    series.push({ atMs, rssBytes: row.rssBytes });
    workers.set(row.pid, series);
  }
}

type CollectOptions = {
  appDir: string;
  workDir: string | undefined;
  pid: number | null;
  stage: CaptureStage;
  baselineRssBytes: number | null;
  afterRssBytes: number | null;
};

/**
 * Turns a finished capture into a usable pair, or cleans up after one that did
 * not finish. A half-captured worker leaves a snapshot behind in the user's
 * project, and nothing in the report would ever refer to it.
 */
async function collectCapture(options: CollectOptions): Promise<BuildCapture | null> {
  const { appDir, workDir, pid, stage, baselineRssBytes, afterRssBytes } = options;
  if (workDir === undefined || pid === null) {
    return null;
  }
  if (stage !== "pair-taken" || baselineRssBytes === null || afterRssBytes === null) {
    await discardSnapshots(appDir, pid);
    return null;
  }
  const files = await collectSnapshotPair(appDir, workDir, pid);
  if (files === null) {
    await discardSnapshots(appDir, pid);
    return null;
  }
  return { pid, files, baselineRssBytes, afterRssBytes };
}

/** The worker that grew the most: a verdict from the average would hide it. */
function worstWorker(workers: readonly WorkerSeries[]): WorkerSeries | null {
  let worst: WorkerSeries | null = null;
  let worstGrowth = -Infinity;
  for (const worker of workers) {
    const growth = netGrowthOf(classifyBuildSamples(worker.samples).levels);
    if (growth > worstGrowth) {
      worstGrowth = growth;
      worst = worker;
    }
  }
  return worst;
}

const peakOf = (samples: readonly BuildSample[]): number =>
  samples.reduce((highest, sample) => Math.max(highest, sample.rssBytes), 0);

/**
 * Measures the memory of a `next build`'s static-generation workers.
 *
 * The build runs unmodified — nothing is injected into it. Workers are child
 * processes with their own resident memory, so the whole measurement is made
 * from outside by watching the process tree.
 */
export async function runBuildMeasurement(
  options: BuildRunOptions,
  deps: BuildRunDeps = defaultDeps
): Promise<BuildRunResult> {
  const target = await validateBuildTarget(options.appDir);
  const progress = options.onProgress ?? ((): void => {});
  const env = options.env ?? process.env;
  const strippedCapWarning = strippedHeapCap(env["NODE_OPTIONS"]);
  if (strippedCapWarning !== null) {
    progress(strippedCapWarning);
  }

  // The worker inherits NODE_OPTIONS, which is how the signal handler gets
  // installed without touching the build. Appending rather than replacing:
  // a user's own NODE_OPTIONS carries their heap cap, and dropping it would
  // silently change what is being measured.
  const capturing = options.workDir !== undefined;
  const buildEnv = capturing
    ? {
        ...env,
        NODE_OPTIONS: `${env["NODE_OPTIONS"] ?? ""} --heapsnapshot-signal=SIGUSR2`.trim(),
      }
    : env;

  progress(`building ${target.appDir}`);
  const child = deps.spawnBuild(target.appDir, buildEnv);
  registerChild(child);

  let output = "";
  const capture = (chunk: Buffer | string): void => {
    output += String(chunk);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const startedAt = deps.now();
  const workerSamples = new Map<number, BuildSample[]>();
  const parentSamples: BuildSample[] = [];
  let finished = false;
  const exit = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      finished = true;
      resolve(code);
    });
  });

  const abort = (): void => {
    child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  let samplingFailure: string | null = null;
  // Capture follows one worker. Signalling every worker of a nine-worker build
  // would write gigabytes for readings that say the same thing, so the first
  // one seen is followed and its pid is reported, and attribution is withheld
  // when the worker that ends up judged is a different one.
  let capturePid: number | null = null;
  let captureStage: CaptureStage = "waiting";
  let captureBaselineRss: number | null = null;
  let captureAfterRss: number | null = null;
  const polling = (async (): Promise<void> => {
    while (!finished) {
      await deps.sleep(POLL_MS);
      if (finished || child.pid === undefined) {
        return;
      }
      const sample = await deps.sampleTable();
      if (!sample.ok) {
        // Every later poll would fail the same way, and a run that cannot see
        // the process table has no business reporting on it.
        samplingFailure = sample.reason;
        return;
      }
      recordSample(sample.rows, child.pid, deps.now() - startedAt, workerSamples, parentSamples);
      if (!capturing) {
        continue;
      }
      // Annotated because `capturePid` is assigned from this value below, which
      // makes the inferred type circular.
      const followed: ProcessRow | undefined =
        capturePid === null
          ? descendantsOf(sample.rows, child.pid).find(isStaticGenWorker)
          : sample.rows.find((row) => row.pid === capturePid);
      if (followed === undefined) {
        continue;
      }
      capturePid ??= followed.pid;
      if (followed.pid !== capturePid) {
        continue;
      }
      const decision = decideCapture(followed.rssBytes, captureStage, captureBaselineRss);
      if (decision === "take-baseline") {
        deps.signalWorker(followed.pid);
        captureStage = "baseline-taken";
        captureBaselineRss = followed.rssBytes;
      } else if (decision === "take-after") {
        deps.signalWorker(followed.pid);
        captureStage = "pair-taken";
        captureAfterRss = followed.rssBytes;
      } else if (decision === "give-up") {
        captureStage = "missed";
      }
    }
  })();

  const exitCode = await exit;
  await polling;
  options.signal?.removeEventListener("abort", abort);
  unregisterChild(child);

  const workers: WorkerSeries[] = [...workerSamples].map(([pid, samples]) => ({ pid, samples }));
  const heapExhausted = diedOfHeapExhaustion(output);
  const workerCapture = await collectCapture({
    appDir: target.appDir,
    workDir: options.workDir,
    pid: capturePid,
    stage: captureStage,
    baselineRssBytes: captureBaselineRss,
    afterRssBytes: captureAfterRss,
  });
  const pagesGenerated = pagesGeneratedFrom(output);

  if (workers.length === 0) {
    return {
      appDir: target.appDir,
      // "Could not look" is not "nothing was there". A build that broke before
      // generating anything is a failed build, not a measurement of nothing.
      status:
        samplingFailure !== null
          ? "cannot-sample"
          : exitCode === 0
            ? "nothing-to-measure"
            : "build-failed",
      samplingFailure,
      verdict: null,
      trend: null,
      levels: [],
      workers,
      parentSamples,
      peakWorkerRssBytes: 0,
      netGrowthBytes: 0,
      pagesGenerated,
      retentionPerPageBytes: null,
      heapExhausted,
      capture: workerCapture,
      strippedCapWarning,
      exitCode,
      output,
    };
  }

  const worst = worstWorker(workers);
  const { trend, levels } = classifyBuildSamples(worst?.samples ?? []);
  const peakWorkerRssBytes = workers.reduce(
    (highest, worker) => Math.max(highest, peakOf(worker.samples)),
    0
  );
  // A worker killed by the heap limit is the finding: the run measured exactly
  // what it set out to, and the build failing is the symptom. A build that
  // broke for any other reason stopped the measurement partway, so its curve
  // supports no claim — the samples are still reported as evidence.
  const measured = exitCode === 0 || heapExhausted;
  // Running out of heap is not a shape to be inferred from, it is the outcome
  // observed. Measured for real on the #97464 repro: the worker died at
  // 1758 MB after 1252 pages and the segmented curve still read `stable`,
  // because one segment gave 79 MB back. A curve cannot overrule a corpse.
  const verdict = heapExhausted ? "leak" : trend.verdict;
  // A worker that died mid-flight has no trustworthy per-page figure. Its
  // segmented curve ends wherever the crash landed — on the real #97464 run,
  // *below* where it started — and the only other base available, the worker's
  // first raw reading, folds module loading and JIT into the numerator. Both
  // were tried against the reproduction: one reported nothing, the other 1.59
  // MB/page against the ~0.9 the issue measures from heapUsed. The honest
  // report for a crashed build is how far it got and what it reached.
  const growthBytes = heapExhausted ? 0 : netGrowthOf(levels);

  return {
    appDir: target.appDir,
    status: measured ? "measured" : "build-failed",
    samplingFailure,
    verdict: measured ? verdict : null,
    trend: measured ? trend : null,
    levels: measured ? levels : [],
    workers,
    parentSamples,
    peakWorkerRssBytes,
    netGrowthBytes: measured ? growthBytes : 0,
    pagesGenerated,
    retentionPerPageBytes:
      measured && growthBytes > 0 && pagesGenerated !== null && pagesGenerated > 0
        ? growthBytes / pagesGenerated
        : null,
    heapExhausted,
    // A pair belonging to a worker other than the one judged supports no claim
    // about the verdict above, so it is dropped rather than reported next to it.
    capture: workerCapture !== null && workerCapture.pid === worst?.pid ? workerCapture : null,
    strippedCapWarning,
    exitCode,
    output,
  };
}
