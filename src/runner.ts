import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { AbandonOrigin } from "./abandon-load.js";
import { attributeDiff, type AttributedDiff } from "./attribution.js";
import {
  assessConfidence,
  effectiveVerdict,
  resolveCycles,
  warrantsIssueDraft,
  type ConfidenceReport,
} from "./confidence.js";
import type { HeapSample } from "./control-server.js";
import { captureEnvironment, type MeasurementEnvironment } from "./environment.js";
import { diffSnapshotFiles, SnapshotError, type HeapDiff } from "./heap-diff.js";
import { DEFAULT_MAX_OLD_SPACE_MB } from "./launcher.js";
import {
  discoverPagesRoutes,
  discoverRoutes,
  type DiscoveredRoute,
  type PrerenderManifest,
} from "./manifests.js";
import { extractModuleRegistry } from "./module-registry.js";
import {
  boundedMarkerOf,
  loadRouteConfig,
  resolveRoutePath,
  type RouteConfig,
} from "./route-config.js";
import {
  HeapExhaustedError,
  RITUAL_DEFAULTS,
  runRitual,
  type LoadOutcome,
  type PeakSample,
  type PhaseTiming,
  type SettleOutcome,
} from "./ritual.js";
import { matchSignatures, readNextVersion, type MatchedSignature } from "./signatures.js";
import { validateTarget, type ValidatedTarget } from "./target.js";
import { planRevalidation, revalidateSecondsFor } from "./isr.js";
import { minGrowthFor, type TrendResult, type TrendVerdict } from "./trend.js";

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
       * Seconds of the ISR revalidation period this route was driven through,
       * when it has one. Absent on routes not served from the ISR cache.
       * Recorded because a curve measured against a cache and one measured
       * against a re-render are different experiments.
       */
      revalidatedEverySeconds?: number;
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
        reason: "snapshot-unreadable";
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
   * Growth the self-check measured on its planted leak, when one ran before
   * this measurement. Its presence is what lets the report say a `stable`
   * verdict was produced by a harness known to work.
   */
  harnessVerifiedAt?: number;
  /** Abort between phases; remaining routes are reported as interrupted. */
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};

/** Conservative local throughput (measured 250–700 rps in validation runs). */
const ESTIMATED_RPS = 250;
const PER_ROUTE_OVERHEAD_SECONDS = 10;
/**
 * Two `SETTLE_POLL_MS` polls: the shortest window in which `waitUntilSettled`
 * can hold two heap readings side by side, so the fastest a cycle's idle phase
 * can possibly end. Keep in step with `ritual.ts`.
 */
const MIN_SETTLE_SECONDS = 4;

export type RunEstimate = {
  /**
   * Costs no run avoids: process launch, GC, snapshots and the minimum
   * settle. Request-serving time is left out on purpose — throughput is the
   * one term that swings 10x between a hello-world route and a real one, so a
   * floor that guessed at it would not be a floor.
   */
  fastSeconds: number;
  /** Full idle window every cycle, at the lowest throughput ever measured. */
  slowSeconds: number;
};

export function estimateRun(routeCount: number, parameters: RunParameters): RunEstimate {
  const settleSeconds = Math.min(MIN_SETTLE_SECONDS, parameters.idleMs / 1000);
  const slowPerRoute =
    parameters.warmupRequests / ESTIMATED_RPS +
    parameters.cycles * (parameters.loadRequests / ESTIMATED_RPS + parameters.idleMs / 1000) +
    PER_ROUTE_OVERHEAD_SECONDS;
  const fastPerRoute = PER_ROUTE_OVERHEAD_SECONDS + parameters.cycles * settleSeconds;
  return {
    fastSeconds: Math.round(routeCount * fastPerRoute),
    slowSeconds: Math.round(routeCount * slowPerRoute),
  };
}

/**
 * A point estimate cannot be right across app weights: the adaptive idle ends
 * as soon as the heap holds still, which on a small app is almost at once. A
 * range says that out loud instead of quoting the worst case as the price.
 */
export function formatEstimate(estimate: RunEstimate): string {
  const fast = formatDuration(estimate.fastSeconds);
  const slow = formatDuration(estimate.slowSeconds);
  return fast === slow ? `≈ ${slow}` : `≈ ${fast}–${slow}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 90) {
    return `${seconds}s`;
  }
  if (seconds < 5400) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}

export type RunnerDeps = {
  ritual: typeof runRitual;
  diff: typeof diffSnapshotFiles;
  freePort: () => Promise<number>;
  registry: typeof extractModuleRegistry;
  nextVersion: typeof readNextVersion;
};

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not allocate a port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

const defaultDeps: RunnerDeps = {
  ritual: runRitual,
  diff: diffSnapshotFiles,
  freePort,
  registry: extractModuleRegistry,
  nextVersion: readNextVersion,
};

/**
 * Filesystem-safe label for a route. Distinct routes MUST get distinct slugs:
 * `/a/b` and `/a_b` used to collapse onto the same `ISSUE-a_b.md`, and any
 * all-non-ASCII path (`/ñ`) became "root", colliding with `/`. A short digest
 * disambiguates whenever the sanitized form loses information.
 */
/**
 * Mean RSS growth per cycle, excluding the warm-up cycle exactly like the
 * heap verdict does. Reported alongside the heap so a flat heap with growing
 * RSS is visible instead of invisible.
 */
function rssTrend(memorySamples: readonly HeapSample[]): number {
  if (memorySamples.length < 3) {
    return 0;
  }
  const deltas: number[] = [];
  for (let index = 2; index < memorySamples.length; index += 1) {
    const current = memorySamples[index]?.rss;
    const previous = memorySamples[index - 1]?.rss;
    if (current === undefined || previous === undefined) {
      return 0;
    }
    deltas.push(current - previous);
  }
  return deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
}

export function routeSlug(route: string): string {
  const sanitized = route.replaceAll(/[^a-zA-Z0-9-]+/g, "_").replace(/^_/, "").replace(/_$/, "");
  if (route === "/") {
    return "root";
  }
  // Only routes made of slashes and slug-safe characters map back one-to-one
  // ("/a/b" → "a_b"). Anything else (a literal "_", "[params]", non-ASCII)
  // could alias another route, so it carries a digest of the full path.
  if (/^\/[a-zA-Z0-9\-/]+$/.test(route)) {
    return sanitized;
  }
  const digest = createHash("sha1").update(route).digest("hex").slice(0, 6);
  return sanitized === "" ? `route-${digest}` : `${sanitized}-${digest}`;
}

type ProgressFn = (message: string) => void;

/** Everything a single route measurement needs, resolved once per run. */
type MeasurementContext = {
  deps: RunnerDeps;
  options: RunOptions;
  target: ValidatedTarget;
  workDir: string;
  routeConfig: RouteConfig;
  registry: Awaited<ReturnType<typeof extractModuleRegistry>>;
  nextVersion: string | null;
  progress: ProgressFn;
};

/** Trailing slashes stripped without a regex, so no backtracking is possible. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Segment-aware selector filtering: "/" selects only "/", "/api" selects
 * "/api" and "/api/health" but never "/apiary".
 */
function filterRoutes(
  routes: DiscoveredRoute[],
  selectors: readonly string[],
  progress: ProgressFn
): DiscoveredRoute[] {
  const matches = (routePath: string, selector: string): boolean => {
    const normalized = trimTrailingSlashes(selector);
    if (normalized === "") {
      return routePath === "/";
    }
    return routePath === normalized || routePath.startsWith(`${normalized}/`);
  };
  for (const selector of selectors) {
    if (!routes.some((route) => matches(route.path, selector))) {
      progress(`selector "${selector}" matched no discovered route`);
    }
  }
  return routes.filter((route) => selectors.some((selector) => matches(route.path, selector)));
}

/** Why a route cannot be measured, or null when it can. */
function skipReason(route: DiscoveredRoute, requestPath: string | null): string | null {
  if (route.unaddressableReason !== undefined) {
    return route.unaddressableReason;
  }
  if (requestPath === null) {
    return "needs sample params for dynamic segments (next-leak.config.json)";
  }
  return null;
}

/** Ritual, audit, diff and attribution for one route in a fresh process. */
async function measureRoute(
  context: MeasurementContext,
  route: DiscoveredRoute,
  requestPath: string,
  index: number,
  pass: { cycles: number; dirSuffix: string } | undefined = undefined
): Promise<RouteReport> {
  const { deps, options, target, workDir, routeConfig, registry, nextVersion, progress } = context;
  // An ISR route serves its cache unless the request carries the build's own
  // revalidation header; without it the load measures the static cache and
  // nothing else.
  const plan = planRevalidation(target.prerender, route.path, routeConfig.headers);
  const revalidateSeconds = revalidateSecondsFor(target.prerender, route.path);
  const bounded = boundedMarkerOf(requestPath);
  const driven = plan.kind === "drive" ? plan.headers : {};
  // Forcing a cached route to re-render for keys it has never served fills its
  // store as a side effect of measuring. With `{n%N}` the key set is bounded
  // and the store settles; with `{n}` it never repeats, so growth is expected
  // and the verdict has to say so.
  const cacheDriven = plan.kind === "drive" && bounded === null;
  const merged = { ...driven, ...(routeConfig.headers ?? {}) };
  const headers = Object.keys(merged).length === 0 ? undefined : merged;
  const result = await deps.ritual({
    serverPath: target.standaloneServer,
    route: requestPath,
    workDir: path.join(
      workDir,
      `${String(index + 1).padStart(2, "0")}-${routeSlug(route.path)}${pass?.dirSuffix ?? ""}`
    ),
    bootstrapPath: options.bootstrapPath,
    appPort: await deps.freePort(),
    ...(cacheDriven && { cacheDriven: true }),
    ...(options.warmupRequests !== undefined && { warmupRequests: options.warmupRequests }),
    ...(options.loadRequests !== undefined && { loadRequests: options.loadRequests }),
    ...(options.connections !== undefined && { connections: options.connections }),
    ...(pass !== undefined
      ? { cycles: pass.cycles }
      : options.cycles !== undefined && { cycles: options.cycles }),
    ...(options.idleMs !== undefined && { idleMs: options.idleMs }),
    ...(options.maxOldSpaceMb !== undefined && { maxOldSpaceMb: options.maxOldSpaceMb }),
    ...(headers !== undefined && { headers }),
    ...(routeConfig.abandonAfterMs !== undefined && {
      abandonAfterMs: routeConfig.abandonAfterMs,
    }),
    ...(routeConfig.abandonFrom !== undefined && {
      abandonFrom: routeConfig.abandonFrom,
    }),
  });

  // Audited before anything is derived from the verdict: a measurement that
  // did not observe what it claims must not drive a diff, an attribution, or
  // a headline.
  const confidence = assessConfidence({
    trend: result.trend,
    loadOutcomes: result.loadOutcomes,
    settleOutcomes: result.settleOutcomes,
    // The audit has to grade against the gate the verdict actually used, or
    // the noise-floor warning describes a threshold nobody applied.
    minGrowthPerCycle: result.minGrowthPerCycle,
    memorySamples: result.memorySamples,
    maxOldSpaceMb: options.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB,
    warmupRequests: options.warmupRequests ?? RITUAL_DEFAULTS.warmupRequests,
    ...(routeConfig.abandonAfterMs !== undefined && {
      abandonAfterMs: routeConfig.abandonAfterMs,
    }),
    ...(routeConfig.abandonFrom !== undefined && {
      abandonFrom: routeConfig.abandonFrom,
    }),
  });
  const verdict = confidence.supersededVerdict ?? result.trend.verdict;
  if (confidence.supersededVerdict !== undefined) {
    progress(`withdrawing ${route.path} verdict: evidence does not support it`);
  }

  let diff: HeapDiff | null = null;
  let attributionGap: MeasuredRoute["attributionGap"];
  if (verdict !== "stable" || options.diffAll === true) {
    progress(`diffing snapshots for ${route.path}`);
    try {
      diff = await deps.diff(result.baselineSnapshot, result.afterSnapshot);
    } catch (cause) {
      // The diff names the retaining object; the verdict does not depend on
      // it. Losing a finished measurement because the extra step failed is
      // the worse outcome by far — measured on the #97424 reproduction, where
      // a 1.7 GB snapshot took the whole run down with it.
      const message = cause instanceof Error ? cause.message : String(cause);
      const advice = smallerRunAdvice(cause, result.requestsPerCycle);
      attributionGap = {
        reason: "snapshot-unreadable",
        detail: `${message}${advice}`,
      };
      progress(`snapshot diff unavailable for ${route.path}: ${message}${advice}`);
    }
  }

  return {
    route: route.path,
    status: "measured",
    requestPath,
    ...(pass !== undefined && { resolvedWithCycles: pass.cycles }),
    samples: result.samples,
    memorySamples: result.memorySamples,
    peaks: result.peaks,
    ...(revalidateSeconds !== null && { revalidatedEverySeconds: revalidateSeconds }),
    ...(bounded !== null && { keyCardinality: bounded.bound }),
    unreclaimedSamples: result.unreclaimedSamples,
    unreclaimedTrend: result.unreclaimedTrend,
    requestsPerCycle: result.requestsPerCycle,
    ...(routeConfig.abandonAfterMs !== undefined && {
      abandon: {
        afterMs: routeConfig.abandonAfterMs,
        from: routeConfig.abandonFrom ?? "first-byte",
      },
    }),
    timings: result.timings,
    loadOutcomes: result.loadOutcomes,
    settleOutcomes: result.settleOutcomes,
    confidence,
    trend: result.trend,
    growthPer1000Requests: (result.trend.growthPerCycle / result.requestsPerCycle) * 1000,
    rssPer1000Requests: (rssTrend(result.memorySamples) / result.requestsPerCycle) * 1000,
    baselineSnapshot: result.baselineSnapshot,
    afterSnapshot: result.afterSnapshot,
    diff,
    ...(attributionGap !== undefined && { attributionGap }),
    attribution: diff === null || registry.size === 0 ? null : attributeDiff(diff, registry),
    signatures: diff === null ? [] : matchSignatures(diff, nextVersion),
  };
}

/** Issue drafts and the self-contained HTML report, written next to run.json. */
async function writeEvidenceBundle(report: RunReport, workDir: string): Promise<void> {
  const { renderHtmlReport } = await import("./html-report.js");
  const { renderIssueMarkdown } = await import("./issue-report.js");

  for (const route of report.routes) {
    // Only a verdict the evidence plainly supports earns a draft: these are
    // written to be pasted into someone else's issue tracker.
    if (route.status === "measured" && warrantsIssueDraft(route)) {
      const file = path.join(workDir, `ISSUE-${routeSlug(route.route)}.md`);
      await writeFile(file, renderIssueMarkdown(route, report));
      report.bundle.issues.push({ route: route.route, file });
    }
  }
  await writeFile(report.bundle.htmlReport, renderHtmlReport(report));
}

/**
 * The `--requests` that would have produced a diffable snapshot.
 *
 * Naming a number beats naming the size that failed: someone reading "1343 MB,
 * past 512 MB" still has to guess what to try next. The estimate assumes the
 * parsed sections scale with the traffic served, which is the same assumption
 * behind the growth gate, and it is rounded down to a round number so nobody
 * reads four significant figures as a promise.
 *
 * Empty string when the failure was not about size, so the caller can append
 * it unconditionally.
 */
function smallerRunAdvice(cause: unknown, requestsPerCycle: number): string {
  const parsedBytes = cause instanceof SnapshotError ? cause.parsedBytes : undefined;
  if (parsedBytes === undefined || parsedBytes <= 0) {
    return "";
  }
  const ceiling = bufferConstants.MAX_STRING_LENGTH;
  // Aim under the ceiling rather than at it: a snapshot that lands on the line
  // is one noisy cycle away from being refused again.
  const suggested = Math.floor(((requestsPerCycle * ceiling) / parsedBytes) * 0.8);
  if (suggested < 1 || suggested >= requestsPerCycle) {
    return "";
  }
  const rounded = suggested >= 100 ? Math.floor(suggested / 100) * 100 : suggested;
  return `. Around --requests ${rounded} should keep it diffable`;
}

/** Skip, measure or record the failure for one route — never throws. */
async function routeReportFor(
  context: MeasurementContext,
  route: DiscoveredRoute,
  index: number,
  total: number
): Promise<RouteReport> {
  const { routeConfig, progress } = context;
  const label = `${route.path} (${index + 1}/${total})`;
  const requestPath = resolveRoutePath(route.path, routeConfig);
  const reason = skipReason(route, requestPath);
  if (reason !== null || requestPath === null) {
    progress(`skipping ${label}: ${reason ?? "needs sample params"}`);
    return { route: route.path, status: "skipped", reason: reason ?? "needs sample params" };
  }
  const plan = planRevalidation(context.target.prerender, route.path, routeConfig.headers);
  if (plan.kind === "cannot-drive") {
    progress(`not measuring ${label}: ${plan.reason}`);
    return { route: route.path, status: "not-exercised", reason: plan.reason };
  }
  return measureWithResolution(context, route, requestPath, index, label);
}

/**
 * Why a route earns a second, longer pass — or null when the first one settles it.
 *
 * `inconclusive` means the evidence does not decide, and the report knows what
 * would: the same route, twice the cycles. Printing that command and stopping
 * asks someone whose pods are restarting to run the tool twice.
 *
 * `saturating` is the same problem wearing a verdict. Its shape requires every
 * cycle to clear the growth gate, so a decelerating curve always ends the
 * window still growing measurably — the bend is real, but where it settles is
 * outside what was measured. A longer window is the only thing that tells a
 * store that runs out from a leak that merely eased off.
 */
function reasonToResolve(verdict: TrendVerdict): string | null {
  switch (verdict) {
    case "inconclusive":
      return "the first pass could not call it";
    case "saturating":
      return "growth was still decelerating when the window ran out";
    case "leak":
    case "stable":
      return null;
  }
}

/** Measures a route, and goes back for a longer look when the verdict earns one. */
async function measureWithResolution(
  context: MeasurementContext,
  route: DiscoveredRoute,
  requestPath: string,
  index: number,
  label: string
): Promise<RouteReport> {
  const { progress } = context;
  try {
    const asPath = requestPath === route.path ? "" : ` as ${requestPath}`;
    progress(`measuring ${label}${asPath}`);
    const first = await measureRoute(context, route, requestPath, index);
    const reason = first.status === "measured" ? reasonToResolve(effectiveVerdict(first)) : null;
    if (first.status !== "measured" || context.options.resolveInconclusive === false || reason === null) {
      return first;
    }
    // A Ctrl+C that lands after the first pass must not start a second one:
    // the user asked the run to stop, and an inconclusive result is still a
    // result worth keeping.
    if (context.options.signal?.aborted === true) {
      return first;
    }
    const cycles = resolveCycles(context.options.cycles ?? RITUAL_DEFAULTS.cycles);
    progress(`re-measuring ${route.path} with ${cycles} cycles: ${reason}`);
    try {
      return await measureRoute(context, route, requestPath, index, {
        cycles,
        dirSuffix: "-resolve",
      });
    } catch (cause) {
      // The second pass is a bonus, not a bet: losing it (port race lost
      // twice, the app dying under the longer run, an interrupt mid-pass)
      // must not discard the valid measurement already in hand.
      progress(
        `re-measurement of ${route.path} failed (${cause instanceof Error ? cause.message : String(cause)}) — keeping the first pass`
      );
      return first;
    }
  } catch (cause) {
    if (cause instanceof HeapExhaustedError) {
      // Not a failure: the route was measured right up to the point where it
      // stopped fitting, which is the strongest evidence a run can produce.
      progress(`leak ${label}: ${cause.message}`);
      const { evidence } = cause;
      return {
        route: route.path,
        status: "died-of-heap",
        requestPath,
        reason: cause.message,
        memorySamples: evidence.memorySamples,
        peaks: evidence.peaks,
        cyclesCompleted: evidence.cyclesCompleted,
        cyclesRequested: evidence.cyclesRequested,
        requestsPerCycle: evidence.requestsPerCycle,
      };
    }
    const failure = cause instanceof Error ? cause.message : String(cause);
    progress(`failed ${label}: ${failure}`);
    return { route: route.path, status: "failed", reason: failure };
  }
}

type RunPlan = {
  routes: DiscoveredRoute[];
  routeConfig: RouteConfig;
  registry: Awaited<ReturnType<typeof extractModuleRegistry>>;
  nextVersion: string | null;
  parameters: RunParameters;
};

/** Route discovery, config and the duration estimate, announced up front. */
async function planRun(
  options: RunOptions,
  target: ValidatedTarget,
  deps: RunnerDeps,
  progress: ProgressFn
): Promise<RunPlan> {
  // Both routers can leak, and an app may ship both. Pages entries come
  // second so an App Router route wins any path collision.
  const discovered = [...discoverRoutes(target.appPaths), ...discoverPagesRoutes(target.pages)];
  const byPath = new Map(discovered.map((route) => [route.path, route]));
  let routes = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (options.routeFilter !== undefined && options.routeFilter.length > 0) {
    routes = filterRoutes(routes, options.routeFilter, progress);
  }

  const registry = await deps.registry(path.join(target.appDir, ".next", "server"));
  const nextVersion = await deps.nextVersion(target.appDir);
  const routeConfig = await loadRouteConfig(target.appDir);
  progress(
    `module registry: ${registry.size} modules` +
      (nextVersion === null ? "" : ` · next ${nextVersion}`)
  );

  const loadRequests = options.loadRequests ?? RITUAL_DEFAULTS.loadRequests;
  const parameters: RunParameters = {
    warmupRequests: options.warmupRequests ?? RITUAL_DEFAULTS.warmupRequests,
    loadRequests,
    connections: options.connections ?? RITUAL_DEFAULTS.connections,
    cycles: options.cycles ?? RITUAL_DEFAULTS.cycles,
    idleMs: options.idleMs ?? RITUAL_DEFAULTS.idleMs,
    maxOldSpaceMb: options.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB,
    minGrowthPerCycle: minGrowthFor(loadRequests),
  };
  // Only routes the runner will actually launch a process for: skipped ones
  // (dynamic without sample params, intercepting, static assets) were
  // inflating the one number whose whole job is to be believable.
  const measurable = routes.filter(
    (route) => skipReason(route, resolveRoutePath(route.path, routeConfig)) === null
  ).length;
  const estimate = estimateRun(measurable, parameters);
  progress(
    `${routes.length} routes discovered` +
      (measurable === routes.length ? "" : ` · ${measurable} measurable`) +
      ` · estimated ${formatEstimate(estimate)}` +
      (options.resolveInconclusive === false
        ? ""
        : " (undecided and still-decelerating routes are measured again)") +
      // Long default runs are where first-time users give up; point at the two
      // ways out. Suppressed once load parameters were tuned by hand (or by
      // --quick, which arrives here as explicit loadRequests/idleMs).
      (estimate.slowSeconds > 15 * 60 &&
      options.loadRequests === undefined &&
      options.idleMs === undefined
        ? " — use --quick for the fast validated preset, or narrow with --routes"
        : "")
  );
  return { routes, routeConfig, registry, nextVersion, parameters };
}

/**
 * Full measurement run: validate the target, discover routes, run the ritual
 * per route in a fresh process, diff snapshots for non-stable verdicts, and
 * persist `run.json` plus raw snapshots under the work directory.
 */
export async function runMeasurement(
  options: RunOptions,
  deps: RunnerDeps = defaultDeps
): Promise<RunReport> {
  const progress = options.onProgress ?? (() => {});
  const target = await validateTarget(options.appDir);
  const { routes, routeConfig, registry, nextVersion, parameters } = await planRun(
    options,
    target,
    deps,
    progress
  );

  const startedAt = new Date();
  const workDir = path.join(
    options.outputDir ?? path.join(target.appDir, ".next-leak"),
    startedAt.toISOString().replace(/[:.]/g, "-")
  );
  await mkdir(workDir, { recursive: true });

  const context: MeasurementContext = {
    deps, options, target, workDir, routeConfig, registry, nextVersion, progress,
  };
  const reports: RouteReport[] = [];

  /**
   * Persisted after every route, not just at the end: a long run must not
   * lose hours of measurements to a sudden death (OOM, a dependency calling
   * process.exit, kill -9). The final write adds the bundle paths.
   */
  const buildReport = (): RunReport => ({
    appDir: target.appDir,
    startedAt: startedAt.toISOString(),
    workDir,
    ...(target.prerender !== undefined && { prerender: target.prerender }),
    harness:
      options.harnessVerifiedAt === undefined
        ? { verified: false }
        : { verified: true, growthPer1000Requests: options.harnessVerifiedAt },
    environment: captureEnvironment(nextVersion),
    parameters,
    routes: reports,
    bundle: { htmlReport: path.join(workDir, "report.html"), issues: [] },
  });
  const persist = async (report: RunReport): Promise<void> => {
    await writeFile(path.join(workDir, "run.json"), `${JSON.stringify(report, null, 2)}\n`);
  };

  for (const [index, route] of routes.entries()) {
    if (options.signal?.aborted === true) {
      reports.push({ route: route.path, status: "skipped", reason: "interrupted" });
      continue;
    }
    reports.push(await routeReportFor(context, route, index, routes.length));
    await persist(buildReport());
  }

  const report = buildReport();
  await writeEvidenceBundle(report, workDir);
  await persist(report);
  return report;
}
