import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
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
  strippedCapWarning: string | null;
  exitCode: number | null;
  output: string;
};

export type BuildRunOptions = {
  appDir: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Overrides `process.env` for the build. */
  env?: NodeJS.ProcessEnv;
};

export type BuildRunDeps = {
  spawnBuild: (appDir: string, env: NodeJS.ProcessEnv) => ChildProcess;
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

const defaultDeps: BuildRunDeps = {
  spawnBuild: spawnNextBuild,
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

  progress(`building ${target.appDir}`);
  const child = deps.spawnBuild(target.appDir, env);
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
    }
  })();

  const exitCode = await exit;
  await polling;
  options.signal?.removeEventListener("abort", abort);
  unregisterChild(child);

  const workers: WorkerSeries[] = [...workerSamples].map(([pid, samples]) => ({ pid, samples }));
  const heapExhausted = diedOfHeapExhaustion(output);
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
    strippedCapWarning,
    exitCode,
    output,
  };
}
