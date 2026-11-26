import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";
import { attributeDiff } from "./attribution.js";
import type { HeapSample } from "./control-server.js";
import { SnapshotError, type HeapDiff } from "./heap-diff.js";
import { cacheRoots, listCache, removeNewEntries, type CacheListing } from "./isr-cleanup.js";
import { auditMeasurement } from "./judge.js";
import { DEFAULT_MAX_OLD_SPACE_MB } from "./launcher.js";
import type { DiscoveredRoute } from "./manifests.js";
import { boundedMarkerOf } from "./route-config.js";
import { RITUAL_DEFAULTS } from "./ritual.js";
import { matchSignatures } from "./signatures.js";
import { planRevalidation, revalidateSecondsFor, revalidates } from "./isr.js";
import type { MeasuredRoute, MeasurementContext, RouteReport, RunOptions } from "./run-types.js";

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

/** The binary a pass runs on: its own, else the run's first, else next-leak's. */
function nodePathOption(
  options: RunOptions,
  passNodePath: string | undefined
): { nodePath?: string } {
  const nodePath = passNodePath ?? options.nodeBinaries?.[0]?.path;
  return nodePath === undefined ? {} : { nodePath };
}

type Pass = { cycles?: number; dirSuffix: string; nodePath?: string } | undefined;

/**
 * How the load reaches a route's cache. An ISR route whose keys repeat serves
 * its cache unless the request carries the build's own revalidation header;
 * without it the load measures the static cache and nothing else. A route asked
 * for a new key every time has no cache to bypass, and the header would only
 * move the measurement onto Next's revalidation path — see planRevalidation.
 */
function cachePlan(context: MeasurementContext, route: DiscoveredRoute, requestPath: string) {
  const { target, routeConfig } = context;
  const plan = planRevalidation(target.prerender, route.path, routeConfig.headers, requestPath);
  const bounded = boundedMarkerOf(requestPath);
  const driven = plan.kind === "drive" ? plan.headers : undefined;
  const merged = { ...driven, ...routeConfig.headers };
  return {
    plan,
    bounded,
    revalidateSeconds: revalidateSecondsFor(target.prerender, route.path),
    servedFromIsrCache: revalidates(target.prerender, route.path),
    // Serving a cached route keys it has never held fills its store as a side
    // effect of measuring. With `{n%N}` the key set is bounded and the store
    // settles; with `{n}` it never repeats, so growth is expected and the
    // verdict has to say so. True whether or not the load drives revalidation.
    cacheDriven: plan.kind === "no-cache-to-drive" || (plan.kind === "drive" && bounded === null),
    headers: Object.keys(merged).length === 0 ? undefined : merged,
  };
}

/** The ritual's options for one pass: the run's settings, the pass's overrides, the route's load shape. */
async function ritualOptionsFor(
  context: MeasurementContext,
  route: DiscoveredRoute,
  requestPath: string,
  index: number,
  pass: Pass,
  cache: ReturnType<typeof cachePlan>
) {
  const { deps, options, target, workDir, routeConfig } = context;
  const cycles = pass?.cycles ?? options.cycles;
  return {
    serverPath: target.standaloneServer,
    ...(options.dev === true && { dev: { appDir: target.appDir } }),
    route: requestPath,
    workDir: path.join(
      workDir,
      `${String(index + 1).padStart(2, "0")}-${routeSlug(route.path)}${pass?.dirSuffix ?? ""}`
    ),
    bootstrapPath: options.bootstrapPath,
    appPort: await deps.freePort(),
    ...nodePathOption(options, pass?.nodePath),
    ...(cache.cacheDriven && { cacheDriven: true }),
    ...(options.warmupRequests !== undefined && { warmupRequests: options.warmupRequests }),
    ...(options.loadRequests !== undefined && { loadRequests: options.loadRequests }),
    ...(options.connections !== undefined && { connections: options.connections }),
    ...(cycles !== undefined && { cycles }),
    ...(options.idleMs !== undefined && { idleMs: options.idleMs }),
    ...(options.maxOldSpaceMb !== undefined && { maxOldSpaceMb: options.maxOldSpaceMb }),
    ...(options.readyTimeoutMs !== undefined && { readyTimeoutMs: options.readyTimeoutMs }),
    ...(cache.headers !== undefined && { headers: cache.headers }),
    ...abandonOptions(routeConfig),
  };
}

function abandonOptions(routeConfig: MeasurementContext["routeConfig"]) {
  return {
    ...(routeConfig.abandonAfterMs !== undefined && { abandonAfterMs: routeConfig.abandonAfterMs }),
    ...(routeConfig.abandonFrom !== undefined && { abandonFrom: routeConfig.abandonFrom }),
  };
}

type RitualOutput = Awaited<ReturnType<MeasurementContext["deps"]["ritual"]>>;

/**
 * The snapshot diff behind a verdict, or why there is none. The diff names the
 * retaining object; the verdict does not depend on it, so losing it never
 * costs the measurement.
 */
async function diffFor(
  context: MeasurementContext,
  route: DiscoveredRoute,
  result: RitualOutput,
  verdict: string
): Promise<{ diff: HeapDiff | null; attributionGap?: MeasuredRoute["attributionGap"] }> {
  const { deps, options, progress } = context;
  if (result.snapshotFailure !== undefined) {
    // The measurement finished; only its last snapshot did not. Say so and
    // keep the verdict, rather than reporting the route as a failure and
    // throwing away every cycle that did complete.
    progress(`no snapshot to attribute for ${route.path}: ${result.snapshotFailure}`);
    return {
      diff: null,
      attributionGap: { reason: "snapshot-unavailable", detail: result.snapshotFailure },
    };
  }
  // `pressure` is excluded alongside `stable`: both describe a process that
  // retained nothing between cycles, so a baseline-to-after diff has nothing
  // to name, and the step is not cheap — a 1.7 GB snapshot took a whole run
  // down on the #97424 reproduction. `--diff-all` still forces it.
  if ((verdict === "stable" || verdict === "pressure") && options.diffAll !== true) {
    return { diff: null };
  }
  // A diff of hundreds of MB is minutes of CPU nothing can interrupt. After a
  // Ctrl+C, or a supervisor's SIGTERM that turns into SIGKILL seconds later,
  // the run's job is to write what it has: the snapshots stay on disk.
  if (options.signal?.aborted === true) {
    return {
      diff: null,
      attributionGap: {
        reason: "interrupted",
        detail: `baseline ${result.baselineSnapshot}, after ${result.afterSnapshot}`,
      },
    };
  }
  progress(`diffing snapshots for ${route.path}`);
  try {
    return { diff: await deps.diff(result.baselineSnapshot, result.afterSnapshot) };
  } catch (cause) {
    // Losing a finished measurement because the extra step failed is the worse
    // outcome by far — measured on the #97424 reproduction, where a 1.7 GB
    // snapshot took the whole run down with it.
    const message = cause instanceof Error ? cause.message : String(cause);
    const advice = smallerRunAdvice(cause, result.requestsPerCycle);
    progress(`snapshot diff unavailable for ${route.path}: ${message}${advice}`);
    return {
      diff: null,
      attributionGap: { reason: "snapshot-unreadable", detail: `${message}${advice}` },
    };
  }
}

/**
 * Runs one measured process and removes the cache entries it wrote.
 *
 * Under `next dev` nothing is persisted next to the build, so there is nothing
 * to remove. The cleanup runs however the process ended: a run that died of
 * heap wrote its renders too.
 */
async function withCacheCleanup<T>(context: MeasurementContext, run: () => Promise<T>): Promise<T> {
  if (context.options.dev === true) {
    return run();
  }
  const roots = cacheRoots(context.target.standaloneServer);
  let before: CacheListing;
  try {
    before = await listCache(roots);
  } catch (cause) {
    // The measurement does not depend on it; a full disk later is the cost.
    context.progress(`cannot list the build's cache, so it will not be cleaned: ${messageOf(cause)}`);
    return run();
  }
  try {
    return await run();
  } finally {
    await reportCleanup(context, before);
  }
}

/** Never throws: a cleanup that fails must not replace the measurement's own outcome. */
async function reportCleanup(context: MeasurementContext, before: CacheListing): Promise<void> {
  try {
    const removed = await removeNewEntries(before);
    if (removed.files > 0) {
      context.progress(
        `removed ${removed.files} cache entr${removed.files === 1 ? "y" : "ies"} ` +
          `(${(removed.bytes / (1024 * 1024)).toFixed(1)} MB) the server wrote next to the build`
      );
    }
  } catch (cause) {
    context.progress(`could not remove the cache entries the server wrote: ${messageOf(cause)}`);
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Ritual, audit, diff and attribution for one route in a fresh process. */
export async function measureRoute(
  context: MeasurementContext,
  route: DiscoveredRoute,
  requestPath: string,
  index: number,
  pass: Pass = undefined
): Promise<RouteReport> {
  const { deps, options, routeConfig, registry, nextVersion, progress } = context;
  const cache = cachePlan(context, route, requestPath);
  const ritualOptions = await ritualOptionsFor(context, route, requestPath, index, pass, cache);
  const result = await withCacheCleanup(context, () => deps.ritual(ritualOptions));

  // Audited before anything is derived from the verdict: a measurement that
  // did not observe what it claims must not drive a diff, an attribution, or
  // a headline.
  const confidence = auditMeasurement(result.trend, {
    memorySamples: result.memorySamples,
    peaks: result.peaks,
    requestsPerCycle: result.requestsPerCycle,
    loadOutcomes: result.loadOutcomes,
    settleOutcomes: result.settleOutcomes,
    maxOldSpaceMb: options.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB,
    warmupRequests: options.warmupRequests ?? RITUAL_DEFAULTS.warmupRequests,
    // Decides whether the cache-residency remedy exists on this route: bounding
    // the keys of an ISR route hands the requests back to the cache.
    revalidatesFromCache: cache.servedFromIsrCache,
    ...abandonOptions(routeConfig),
  });
  const verdict = confidence.supersededVerdict ?? result.trend.verdict;
  if (confidence.supersededVerdict !== undefined) {
    progress(`withdrawing ${route.path} verdict: evidence does not support it`);
  }
  const { diff, attributionGap } = await diffFor(context, route, result, verdict);

  return {
    route: route.path,
    status: "measured",
    requestPath,
    ...(pass?.cycles !== undefined && { resolvedWithCycles: pass.cycles }),
    samples: result.samples,
    memorySamples: result.memorySamples,
    peaks: result.peaks,
    ...(cache.revalidateSeconds !== null && { revalidatedEverySeconds: cache.revalidateSeconds }),
    ...(cache.servedFromIsrCache && { servedFromIsrCache: true as const }),
    ...(cache.plan.kind === "drive" && { revalidationDriven: true as const }),
    ...(cache.bounded !== null && { keyCardinality: cache.bounded.bound }),
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
