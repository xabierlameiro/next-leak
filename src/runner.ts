import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { attributeDiff, type AttributedDiff } from "./attribution.js";
import {
  assessConfidence,
  effectiveVerdict,
  warrantsIssueDraft,
  type ConfidenceReport,
} from "./confidence.js";
import type { HeapSample } from "./control-server.js";
import { captureEnvironment, type MeasurementEnvironment } from "./environment.js";
import { diffSnapshotFiles, type HeapDiff } from "./heap-diff.js";
import { discoverPagesRoutes, discoverRoutes, type DiscoveredRoute } from "./manifests.js";
import { extractModuleRegistry } from "./module-registry.js";
import { loadRouteConfig, resolveRoutePath, type RouteConfig } from "./route-config.js";
import {
  RITUAL_DEFAULTS,
  runRitual,
  type LoadOutcome,
  type PhaseTiming,
  type SettleOutcome,
} from "./ritual.js";
import { matchSignatures, readNextVersion, type MatchedSignature } from "./signatures.js";
import { validateTarget, type ValidatedTarget } from "./target.js";
import type { TrendResult } from "./trend.js";

export type RouteReport =
  | { route: string; status: "skipped"; reason: string }
  | { route: string; status: "failed"; reason: string }
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
      /** Null when there is no diff or no module registry. */
      attribution: AttributedDiff | null;
      signatures: MatchedSignature[];
    };

export type MeasuredRoute = Extract<RouteReport, { status: "measured" }>;

export type RunParameters = {
  warmupRequests: number;
  loadRequests: number;
  connections: number;
  cycles: number;
  idleMs: number;
};

export type RunReport = {
  appDir: string;
  startedAt: string;
  workDir: string;
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
  /** Also diff routes with a stable verdict. Default false: diffs are slow. */
  diffAll?: boolean;
  /** Only measure routes matching these templates or prefixes. */
  routeFilter?: string[];
  /** Abort between phases; remaining routes are reported as interrupted. */
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};

/** Conservative local throughput (measured 250–700 rps in validation runs). */
const ESTIMATED_RPS = 250;
const PER_ROUTE_OVERHEAD_SECONDS = 10;

export function estimateRunSeconds(routeCount: number, parameters: RunParameters): number {
  const perRoute =
    parameters.warmupRequests / ESTIMATED_RPS +
    parameters.cycles * (parameters.loadRequests / ESTIMATED_RPS + parameters.idleMs / 1000) +
    PER_ROUTE_OVERHEAD_SECONDS;
  return Math.round(routeCount * perRoute);
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
  const sanitized = route.replace(/[^a-zA-Z0-9-]+/g, "_").replace(/^_+|_+$/g, "");
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
    const normalized = selector.replace(/\/+$/, "");
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
  index: number
): Promise<RouteReport> {
  const { deps, options, target, workDir, routeConfig, registry, nextVersion, progress } = context;
  const result = await deps.ritual({
    serverPath: target.standaloneServer,
    route: requestPath,
    workDir: path.join(workDir, `${String(index + 1).padStart(2, "0")}-${routeSlug(route.path)}`),
    bootstrapPath: options.bootstrapPath,
    appPort: await deps.freePort(),
    ...(options.warmupRequests !== undefined && { warmupRequests: options.warmupRequests }),
    ...(options.loadRequests !== undefined && { loadRequests: options.loadRequests }),
    ...(options.connections !== undefined && { connections: options.connections }),
    ...(options.cycles !== undefined && { cycles: options.cycles }),
    ...(options.idleMs !== undefined && { idleMs: options.idleMs }),
    ...(routeConfig.headers !== undefined && { headers: routeConfig.headers }),
    ...(routeConfig.abandonAfterMs !== undefined && {
      abandonAfterMs: routeConfig.abandonAfterMs,
    }),
  });

  // Audited before anything is derived from the verdict: a measurement that
  // did not observe what it claims must not drive a diff, an attribution, or
  // a headline.
  const confidence = assessConfidence({
    trend: result.trend,
    loadOutcomes: result.loadOutcomes,
    settleOutcomes: result.settleOutcomes,
    ...(routeConfig.abandonAfterMs !== undefined && {
      abandonAfterMs: routeConfig.abandonAfterMs,
    }),
  });
  const verdict = confidence.supersededVerdict ?? result.trend.verdict;
  if (confidence.supersededVerdict !== undefined) {
    progress(`withdrawing ${route.path} verdict: evidence does not support it`);
  }

  let diff: HeapDiff | null = null;
  if (verdict !== "stable" || options.diffAll === true) {
    progress(`diffing snapshots for ${route.path}`);
    diff = await deps.diff(result.baselineSnapshot, result.afterSnapshot);
  }

  return {
    route: route.path,
    status: "measured",
    requestPath,
    samples: result.samples,
    memorySamples: result.memorySamples,
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
  try {
    progress(`measuring ${label}${requestPath === route.path ? "" : ` as ${requestPath}`}`);
    return await measureRoute(context, route, requestPath, index);
  } catch (cause) {
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

  const parameters: RunParameters = {
    warmupRequests: options.warmupRequests ?? RITUAL_DEFAULTS.warmupRequests,
    loadRequests: options.loadRequests ?? RITUAL_DEFAULTS.loadRequests,
    connections: options.connections ?? RITUAL_DEFAULTS.connections,
    cycles: options.cycles ?? RITUAL_DEFAULTS.cycles,
    idleMs: options.idleMs ?? RITUAL_DEFAULTS.idleMs,
  };
  const estimatedSeconds = estimateRunSeconds(
    routes.filter((route) => resolveRoutePath(route.path, routeConfig) !== null).length,
    parameters
  );
  progress(
    `${routes.length} routes discovered · estimated ≈ ${formatDuration(estimatedSeconds)}` +
      // Long default runs are where first-time users give up; point at the two
      // ways out. Suppressed once load parameters were tuned by hand (or by
      // --quick, which arrives here as explicit loadRequests/idleMs).
      (estimatedSeconds > 15 * 60 && options.loadRequests === undefined && options.idleMs === undefined
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
