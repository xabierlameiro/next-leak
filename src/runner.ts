import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { warrantsIssueDraft } from "./confidence.js";
import { captureEnvironment, memoryLimitBytes, memoryLimitWarning } from "./environment.js";
import { diffSnapshotFiles } from "./heap-diff.js";
import { DEFAULT_MAX_OLD_SPACE_MB } from "./launcher.js";
import {
  discoverPagesRoutes,
  discoverRoutes,
  type DiscoveredRoute,
} from "./manifests.js";
import { extractModuleRegistry } from "./module-registry.js";
import { loadRouteConfig, mixesMarkers, resolveRoutePath, type RouteConfig } from "./route-config.js";
import { RITUAL_DEFAULTS, runRitual } from "./ritual.js";
import { readNextVersion } from "./signatures.js";
import { validateTarget, type ValidatedTarget } from "./target.js";
import { validateDevTarget } from "./dev-target.js";
import { planRevalidation } from "./isr.js";
import { minGrowthFor } from "./trend.js";
import { routeSlug } from "./route-measure.js";
import { DEFAULT_CONFIRM_BUDGET_MS, measureRepeatedly } from "./route-passes.js";
import type {
  MeasurementContext,
  ProgressFn,
  RouteReport,
  RunnerDeps,
  RunOptions,
  RunParameters,
  RunReport,
} from "./run-types.js";

export type {
  MeasuredRoute,
  NodeVersionResult,
  RepetitionSummary,
  RouteReport,
  RunnerDeps,
  RunOptions,
  RunParameters,
  RunReport,
} from "./run-types.js";
export { routeSlug } from "./route-measure.js";
export { aggregateRepetitions } from "./route-passes.js";

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
  if (mixesMarkers(requestPath)) {
    return (
      `mixes "{n}" and "{n%N}" across its params in next-leak.config.json — the load ` +
      `resolves one and sends the other as a literal, so every request would ask for a ` +
      `path with "{n}" in it. Pick one cardinality for the whole route.`
    );
  }
  return null;
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
  const plan = planRevalidation(
    context.target.prerender,
    route.path,
    routeConfig.headers,
    requestPath
  );
  if (plan.kind === "cannot-drive") {
    progress(`not measuring ${label}: ${plan.reason}`);
    return { route: route.path, status: "not-exercised", reason: plan.reason };
  }
  return measureRepeatedly(context, route, requestPath, index, label);
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

  // A dev server has no production chunk set to read module ids from.
  const registry: Awaited<ReturnType<typeof deps.registry>> =
    options.dev === true
      ? new Map()
      : await deps.registry(path.join(target.appDir, ".next", "server"));
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
 * A dev app in the shape the run reads: the Next CLI stands where the
 * standalone server would, and nothing is prerendered.
 */
async function devTarget(appDir: string): Promise<ValidatedTarget> {
  const dev = await validateDevTarget(appDir);
  return {
    appDir: dev.appDir,
    standaloneServer: dev.nextBin,
    appPaths: dev.appPaths,
    pages: dev.pages,
    routes: undefined,
    prerender: undefined,
  };
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
  const target = options.dev === true ? await devTarget(options.appDir) : await validateTarget(options.appDir);
  const { routes, routeConfig, registry, nextVersion, parameters } = await planRun(
    options,
    target,
    deps,
    progress
  );

  const memoryLimit = (deps.memoryLimit ?? (() => memoryLimitBytes()))();
  const limitWarning = memoryLimitWarning({
    limitBytes: memoryLimit,
    maxOldSpaceMb: parameters.maxOldSpaceMb,
    dev: options.dev === true,
  });
  if (limitWarning !== null) {
    progress(`warning: ${limitWarning}`);
  }

  const startedAt = new Date();
  const workDir = path.join(
    options.outputDir ?? path.join(target.appDir, ".next-leak"),
    startedAt.toISOString().replace(/[:.]/g, "-")
  );
  await mkdir(workDir, { recursive: true });

  const context: MeasurementContext = {
    deps, options, target, workDir, routeConfig, registry, nextVersion, progress,
    confirmBudget: { remainingMs: options.confirmBudgetMs ?? DEFAULT_CONFIRM_BUDGET_MS },
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
    ...(options.dev === true && { server: "dev" as const }),
    ...(target.prerender !== undefined && { prerender: target.prerender }),
    harness:
      options.harnessVerifiedAt === undefined
        ? { verified: false }
        : { verified: true, growthPer1000Requests: options.harnessVerifiedAt },
    environment: captureEnvironment(
      nextVersion,
      (options.nodeBinaries ?? []).map((binary) => binary.version),
      memoryLimit
    ),
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
