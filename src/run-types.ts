import type { AbandonOrigin } from "./abandon-load.js";
import type { AttributedDiff } from "./attribution.js";
import type { ConfidenceReport } from "./confidence.js";
import type { HeapSample } from "./control-server.js";
import type { MeasurementEnvironment } from "./environment.js";
import type { extractModuleRegistry } from "./module-registry.js";
import type { PrerenderManifest } from "./manifests.js";
import type { NodeBinary } from "./node-binaries.js";
import type { diffSnapshotFiles, HeapDiff } from "./heap-diff.js";
import type { RouteConfig } from "./route-config.js";
import type {
  LoadOutcome,
  PeakSample,
  PhaseTiming,
  runRitual,
  SettleOutcome,
} from "./ritual.js";
import type { MatchedSignature, readNextVersion } from "./signatures.js";
import type { ValidatedTarget } from "./target.js";
import type { TrendResult, TrendVerdict } from "./trend.js";

/** What one repetition of a route concluded, for disclosing the spread. */
export type RepetitionSummary = {
  verdict: TrendVerdict;
  /** Growth normalized by traffic, so repetitions stay comparable. */
  growthPer1000Requests: number;
};

/** One Node version's result for a route, when a run compared several. */
export type NodeVersionResult = {
  version: string;
  status: RouteReport["status"];
  /** The verdict as reported, after the audit. Absent when the route did not measure. */
  verdict?: TrendVerdict;
  growthPer1000Requests?: number;
  /** Heap plus external memory after the last cycle. */
  heldBytes?: number;
};

export type RouteReport =
  | { route: string; status: "skipped"; reason: string }
  | { route: string; status: "failed"; reason: string }
  /**
   * The measured process ran out of heap partway through. This is a verdict,
   * not a failure: the route did not fit in the limit the run gave it, and the
   * outcome decides regardless of the shape of the truncated curve — the same
   * rule the build path applies to a static-generation worker that dies.
   *
   * Kept apart from `measured` because there is no after-snapshot and no
   * complete trend, and dressing it as a full measurement would claim data
   * that does not exist.
   */
  | {
      route: string;
      status: "died-of-heap";
      requestPath: string;
      reason: string;
      /** Post-GC readings up to the death; may be as short as the baseline. */
      memorySamples: HeapSample[];
      peaks: PeakSample[];
      cyclesCompleted: number;
      cyclesRequested: number;
      requestsPerCycle: number;
    }
  /**
   * The route was reachable, but the load could not have exercised the code
   * path it represents — so no verdict is emitted. Measuring an ISR route
   * without driving revalidation reports a flat curve about the static cache,
   * which reads as health and is not.
   */
  | { route: string; status: "not-exercised"; reason: string }
  | {
      route: string;
      status: "measured";
      /** Concrete path requested (differs from `route` for dynamic templates). */
      requestPath: string;
      samples: number[];
      /**
       * Full post-GC memory samples. RSS matters as much as the heap: a
       * process can hold gigabytes of RSS with a flat JS heap (allocator
       * behaviour, external buffers), which is a different diagnosis and a
       * different fix than a heap leak.
       */
      memorySamples: HeapSample[];
      /**
       * Highest memory reached *during* each load cycle. Every other number
       * here is post-GC; this is the one a container limit is judged against.
       */
      peaks: PeakSample[];
      /**
       * One reading per cycle taken before any forced collection, and the
       * trend over them. What a production process holds between full GCs is
       * not what this tool's verdict measures — see `unreclaimed-retention`.
       * Empty when a reading was lost: a hole would make every later delta
       * span two cycles.
       */
      unreclaimedSamples: HeapSample[];
      unreclaimedTrend: TrendResult;
      /** Requests each cycle served — what the growth rates normalize by. */
      requestsPerCycle: number;
      /**
       * One entry per repetition when `repeat` was greater than 1, in the
       * order they ran. Absent for a single measurement, so `run.json` keeps
       * its existing shape unless repetition was asked for.
       */
      repetitions?: RepetitionSummary[];
      /** One entry per `--node` binary, in order, when the run compared several. */
      nodeVersions?: NodeVersionResult[];
      /**
       * The early-disconnect regime, when the route asked for one. Recorded
       * because a curve measured with cuts landing mid-stream and one measured
       * with cuts landing before the response are different experiments, and
       * the counters alone do not say which was intended.
       */
      abandon?: { afterMs: number; from: AbandonOrigin };
      /**
       * Distinct keys the load cycled through, when the route asked for a
       * bounded set. A verdict about a cache depends on how many keys it saw,
       * so the number belongs on the record with the rest of the regime.
       */
      keyCardinality?: number;
      /**
       * Seconds of this route's ISR revalidation period. Absent on routes not
       * served from the ISR cache. Recorded because a curve measured against a
       * cache and one measured against a re-render are different experiments.
       */
      revalidatedEverySeconds?: number;
      /**
       * Set on every route served from the ISR cache, including a dynamic
       * template that caches each new key with no prerendered entry to carry
       * its period — the period is then absent, but the cache is in play.
       */
      servedFromIsrCache?: true;
      /**
       * Whether the load carried the build's own revalidation header. Set apart
       * from the period because the two answer different questions: the period
       * says the ISR cache is in play, this says which of Next's two paths
       * served the requests that produced the curve.
       */
      revalidationDriven?: true;
      /** RSS growth per 1000 requests, computed like the heap figure. */
      rssPer1000Requests: number;
      /** Wall-clock per phase — explains where a long run spent its time. */
      timings: PhaseTiming[];
      /** What each load phase actually did (sent, 2xx, abandoned…). */
      loadOutcomes: LoadOutcome[];
      /** Whether the heap held still before each sample. */
      settleOutcomes: SettleOutcome[];
      /**
       * Audit of the measurement against its own evidence. `trend` stays as
       * measured; when the evidence does not support it, `confidence`
       * carries the verdict that does — see `effectiveVerdict`.
       */
      confidence: ConfidenceReport;
      trend: TrendResult;
      growthPer1000Requests: number;
      baselineSnapshot: string;
      afterSnapshot: string;
      /** Null when the verdict is stable and diffAll was not requested. */
      diff: HeapDiff | null;
      /**
       * Why this route has no attribution, when the diff was attempted and
       * could not run.
       *
       * An absent diff and an unreadable snapshot both surface as `diff: null`,
       * and they are opposite findings: one says nothing grew enough to name,
       * the other says the evidence could not be read. A report that conflates
       * them lets a leak with no attribution pass for a leak with nothing to
       * attribute.
       */
      attributionGap?: {
        /**
         * `snapshot-unreadable`: both snapshots exist, the diff refused them.
         * `snapshot-unavailable`: the final snapshot was never taken, so there
         * is nothing to diff. Either way the verdict below still stands.
         */
        reason: "snapshot-unreadable" | "snapshot-unavailable";
        detail: string;
      };
      /** Null when there is no diff or no module registry. */
      attribution: AttributedDiff | null;
      signatures: MatchedSignature[];
      /**
       * Cycles used by the second pass, when the first came back
       * `inconclusive` and the run went back for more evidence.
       */
      resolvedWithCycles?: number;
    };

export type MeasuredRoute = Extract<RouteReport, { status: "measured" }>;

export type RunParameters = {
  warmupRequests: number;
  loadRequests: number;
  connections: number;
  cycles: number;
  idleMs: number;
  /**
   * Old-space cap of each measured process (MB). Part of the measurement
   * regime: a run near its ceiling is not the same experiment as one with
   * headroom, so it belongs on the record.
   */
  maxOldSpaceMb: number;
  /**
   * Per-cycle growth gate the verdicts were judged against (bytes). Derived
   * from `loadRequests`; recorded because a verdict whose threshold is not
   * printed cannot be audited or reproduced.
   */
  minGrowthPerCycle: number;
};

export type RunReport = {
  appDir: string;
  startedAt: string;
  workDir: string;
  /** `dev` when the run measured `next dev`; absent for a standalone server. */
  server?: "dev";
  /** Carried so the report can suggest sample params the build already knows. */
  prerender?: PrerenderManifest;
  /**
   * Whether a leak of known size was detected in this environment during this
   * session.
   *
   * A `stable` verdict means either "the app does not leak" or "the
   * measurement did not work", and a flat curve looks the same both ways. When
   * this says verified, the second reading is excluded; when it does not, the
   * report must not imply otherwise. Absent verification is the ordinary case,
   * not a failure.
   */
  harness: { verified: false } | { verified: true; growthPer1000Requests: number };
  environment: MeasurementEnvironment;
  parameters: RunParameters;
  routes: RouteReport[];
  bundle: {
    htmlReport: string;
    issues: Array<{ route: string; file: string }>;
  };
};

export type RunOptions = {
  appDir: string;
  /** Built bootstrap module for `--import` into measured processes. */
  bootstrapPath: string;
  /** Parent output directory. Default: `<appDir>/.next-leak`. */
  outputDir?: string;
  warmupRequests?: number;
  loadRequests?: number;
  connections?: number;
  cycles?: number;
  idleMs?: number;
  /** Old-space cap for each measured process (MB). Default 512. */
  maxOldSpaceMb?: number;
  /**
   * How long each measured process gets to start listening, in milliseconds.
   * Default: `DEFAULT_READY_TIMEOUT_MS`.
   */
  readyTimeoutMs?: number;
  /** Also diff routes with a stable verdict. Default false: diffs are slow. */
  diffAll?: boolean;
  /** Only measure routes matching these templates or prefixes. */
  routeFilter?: string[];
  /**
   * Measure a route again, with more cycles, when the first pass could not
   * call it. Default true: the run should answer the question it was asked.
   */
  resolveInconclusive?: boolean;
  /**
   * How many times to measure each route, each from a fresh server. Default 1.
   *
   * Distinct from `cycles`, which watches a single process for longer. The
   * variance that makes a number unpublishable is between processes.
   */
  repeat?: number;
  /**
   * Wall time the low-confidence confirmations may take in all, in ms.
   * Default `DEFAULT_CONFIRM_BUDGET_MS`, no cap; 0 turns them off. A borderline
   * leak is confirmed regardless: that confirmation guards an accusation.
   */
  confirmBudgetMs?: number;
  /**
   * Node binaries the measured server runs on, checked up front. Several
   * measure each route once per binary; the first is the headline.
   */
  nodeBinaries?: NodeBinary[];
  /**
   * Measure on `next dev` instead of a standalone build. Routes come from the
   * app's source, there is no ISR to drive and no production chunk set to name
   * owners from.
   */
  dev?: boolean;
  /**
   * Growth the self-check measured on its planted leak, when one ran before
   * this measurement. Its presence is what lets the report say a `stable`
   * verdict was produced by a harness known to work.
   */
  harnessVerifiedAt?: number;
  /** Abort between phases; remaining routes are reported as interrupted. */
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};

export type RunnerDeps = {
  ritual: typeof runRitual;
  diff: typeof diffSnapshotFiles;
  freePort: () => Promise<number>;
  registry: typeof extractModuleRegistry;
  nextVersion: typeof readNextVersion;
  /** Wall clock in ms, for the confirmation budget. Default `Date.now`. */
  now?: () => number;
  /** The container's memory limit in bytes, null when none. Default: what Node reads. */
  memoryLimit?: () => number | null;
};

export type ProgressFn = (message: string) => void;

/** Everything a single route measurement needs, resolved once per run. */
export type MeasurementContext = {
  deps: RunnerDeps;
  options: RunOptions;
  target: ValidatedTarget;
  workDir: string;
  routeConfig: RouteConfig;
  registry: Awaited<ReturnType<typeof extractModuleRegistry>>;
  nextVersion: string | null;
  progress: ProgressFn;
  /** What is left of the confirmation budget, spent as the run goes. */
  confirmBudget: { remainingMs: number };
};

