import type { TrendResult } from "./trend.js";
import type { HeapSample } from "./control-server.js";
import type { PeakSample } from "./ritual.js";

/**
 * Which ceiling the process came closest to.
 *
 * `heap` is the only class bounded by `--max-old-space`; `rss` is what a
 * container kills. `external`/`arrayBuffers` live in rss, which is why they
 * are reported through it instead of against a limit that does not apply to
 * them (vercel/next.js#92287: a healthy heap next to 4.3 GB of arrayBuffers).
 */
export type PeakPressureClass = "heap" | "rss";

export type PeakPressure = {
  class: PeakPressureClass;
  /** Highest value observed for that class, across cycles (bytes). */
  peakBytes: number;
  /** Retained heap the verdict was computed on (bytes). */
  retainedBytes: number;
  /** Heap limit in force, in bytes. */
  heapLimitBytes: number;
};

export type PeakPressureInput = {
  peaks: readonly PeakSample[];
  /** Post-GC heapUsed of the final sample: what the route actually retains. */
  retainedHeapBytes: number;
  maxOldSpaceMb: number;
};

const MB = 1024 * 1024;

/** Close enough to the V8 ceiling that the next percentile of traffic hits it. */
const HEAP_LIMIT_SHARE = 0.75;
/** How many times its retained heap a process may transiently hold, unremarked. */
const RSS_OVER_RETAINED = 8;
/**
 * Absolute floor for the rss trigger. Without it every small app fires: a 4 MB
 * baseline peaking at 40 MB is arithmetically 10x and operationally nothing.
 */
const RSS_FLOOR_BYTES = 512 * MB;

const maxOf = (peaks: readonly PeakSample[], read: (peak: PeakSample) => number): number =>
  peaks.reduce((highest, peak) => Math.max(highest, read(peak)), 0);

/**
 * What a route retains once it has served traffic: the floor of the post-GC
 * cycle samples, not the last of them.
 *
 * Every sample here follows a forced collection, but "after a forced
 * collection" is not "after everything collectable was collected" — a sample
 * can carry memory the collector had not reached yet. Measured on the
 * vercel/next.js#92287 reproduction, 2026-09-24, one run's cycle samples were
 * 217.1 / 125.0 / 45.2 / 194.9 MB, and the next run's were 69.3 / 121.2 / 48.4
 * / 41.0. Taking the last put the figure everything here divides by at 194.9 MB
 * on one run and 41.0 MB on the other, which by itself decided whether the same
 * app under the same load was reported at all.
 *
 * The floor is the honest reading: what a process comes back down to is what it
 * holds, and everything above it is memory not yet reclaimed. The baseline is
 * excluded because it precedes any traffic — a route retains nothing before it
 * has served anything, and dividing by that would make every route look
 * disproportionate.
 */
export function retainedAfterLoad(memorySamples: readonly HeapSample[]): number | undefined {
  const cycles = memorySamples.slice(1);
  return cycles.length === 0
    ? undefined
    : cycles.reduce((lowest, sample) => Math.min(lowest, sample.heapUsed), Infinity);
}

/**
 * The two ceiling rules, as a single definition each.
 *
 * `assessPeakPressure` applies them to the highest reading of a run, and
 * `assessPressureVerdict` applies them to one cycle at a time. Same thresholds,
 * asked of a different reading — which is the only difference between a note
 * about a run and a verdict about a regime.
 */
const reachesHeapCeiling = (heapUsed: number, heapLimitBytes: number): boolean =>
  heapUsed >= heapLimitBytes * HEAP_LIMIT_SHARE;

const reachesRssCeiling = (rss: number, retainedHeapBytes: number): boolean =>
  rss >= RSS_FLOOR_BYTES && rss >= retainedHeapBytes * RSS_OVER_RETAINED;

/**
 * Whether a route's peak is far enough from the memory its verdict was
 * computed on to be worth saying out loud.
 *
 * On its own this stays outside the verdict, and for the original reason:
 * `leak`/`stable` are statements about retention after GC, calibrated against
 * real leaks with no false positives, and a peak is a different axis. A single
 * high peak is a size, not a direction — an app that reserves 600 MB on its
 * first cycle and holds that level is doing nothing wrong.
 *
 * What the note alone could not carry is the rest of that sentence: a process
 * that climbs to 3.5 GB and hands it all back is honestly `stable`, and still
 * OOM-killed in a 1 GB container. `assessPressureVerdict` below is where a run
 * that reaches the ceiling on every cycle stops being a footnote under a `✔`.
 */
export function assessPeakPressure(input: PeakPressureInput): PeakPressure | null {
  const sampled = input.peaks.filter((peak) => peak.polls > 0);
  if (sampled.length === 0) {
    return null;
  }
  const heapLimitBytes = input.maxOldSpaceMb * MB;
  const peakHeap = maxOf(sampled, (peak) => peak.heapUsed);
  const peakRss = maxOf(sampled, (peak) => peak.rss);

  if (reachesHeapCeiling(peakHeap, heapLimitBytes)) {
    return {
      class: "heap",
      peakBytes: peakHeap,
      retainedBytes: input.retainedHeapBytes,
      heapLimitBytes,
    };
  }
  if (reachesRssCeiling(peakRss, input.retainedHeapBytes)) {
    return {
      class: "rss",
      peakBytes: peakRss,
      retainedBytes: input.retainedHeapBytes,
      heapLimitBytes,
    };
  }
  return null;
}

export type PressureVerdictInput = {
  /** The post-GC verdict, exactly as the classifier produced it. */
  trend: TrendResult;
  peaks: readonly PeakSample[];
  retainedHeapBytes: number;
  maxOldSpaceMb: number;
};

/**
 * Settled cycles that must reach the ceiling before it counts as a regime.
 *
 * Warm-up is dropped first, so this is two cycles that each carry compilation
 * and lazy initialisation behind them. Two is the smallest number that can say
 * "again": one cycle at the ceiling is an episode, and a route that compiles a
 * 900 MB fixture once should not be accused for it.
 */
const PRESSURE_MIN_SETTLED_CYCLES = 2;

/** Applies the ceiling rule for the reported class to a single cycle. */
const reachesCeiling = (
  peak: PeakSample,
  pressureClass: PeakPressureClass,
  input: PressureVerdictInput
): boolean =>
  pressureClass === "heap"
    ? reachesHeapCeiling(peak.heapUsed, input.maxOldSpaceMb * MB)
    : reachesRssCeiling(peak.rss, input.retainedHeapBytes);

/**
 * Whether the run reached the ceiling on every settled cycle.
 *
 * This replaced a climb test, and the reason is measured rather than
 * theoretical. Under this ritual a peak series cannot climb: every cycle is
 * preceded by a forced collection and runs the same traffic, so the peak
 * converges on traffic × cost-per-request. On the vercel/next.js#92287
 * reproduction, 2026-09-24, the rss peaks were 1229.3 / 1344.3 / 1368.7 /
 * 1379.3 MB — deltas of +115, +24.4 and +10.6, an asymptote rather than a ramp.
 * The climb test left the verdict unreachable in exactly the case it was
 * written for, and the tighter argument is that it was never needed: if a
 * forced GC does not hand the memory back, the post-GC series grows and the
 * ordinary classifier already says `leak`, so nothing is left for this verdict
 * to catch by looking for a slope.
 *
 * What separates this from an app that legitimately reserves 1.3 GB is not a
 * direction, it is that a working set is *retained*: it survives the forced
 * collection and lands in `retainedHeapBytes`, so `RSS_OVER_RETAINED` acquits
 * it without any help from a slope. What is left to rule out is the one-off —
 * a single cycle that reached the ceiling for a reason that will not repeat —
 * and repetition, not growth, is what rules that out.
 *
 * Every cycle must have been polled. A cycle with no readings cannot be said to
 * have reached anything, and treating it as if it had would turn a hole in the
 * measurement into evidence.
 */
function isSustained(input: PressureVerdictInput, pressureClass: PeakPressureClass): boolean {
  if (!input.peaks.every((peak) => peak.polls > 0)) {
    return false;
  }
  const settled = input.peaks.slice(1);
  if (settled.length < PRESSURE_MIN_SETTLED_CYCLES) {
    return false;
  }
  return settled.every((peak) => reachesCeiling(peak, pressureClass, input));
}

/**
 * Whether a run that retains nothing is nonetheless heading for the ceiling.
 *
 * Every number a verdict is computed from is taken after a forced collection,
 * and production never runs those. That makes the verdict structurally blind to
 * a whole class of death: memory a full GC does reclaim, allocated faster than
 * the runtime reclaims it on its own. Measured on the vercel/next.js#92287
 * reproduction, 2026-09-23 — the app grew ~1 MB of `arrayBuffers` per request
 * to over 3 GB and died, and this tool called it `stable` at -9.00 MB/1000
 * requests, because a forced GC handed all of it back before every sample. That
 * is the trap next-leak exists to warn other people about.
 *
 * Three conditions, and no threshold of its own: the ceiling rules are
 * `assessPeakPressure`'s, asked of each cycle instead of the highest reading.
 *
 * - **The post-GC verdict is `stable` or `saturating`.** `leak` is already the
 *   worse news and `inconclusive` is an admission that the series did not
 *   decide — promoting *that* to an accusation would be inventing a finding out
 *   of a measurement that failed.
 * - **The peak is far enough from what the route retains to be remarked on** —
 *   `assessPeakPressure`, thresholds unchanged.
 * - **Every settled cycle reached that ceiling**, not just the highest one.
 *   This is the condition that makes the verdict safe. A single high peak is an
 *   episode and gets only the note; a process that returns to the ceiling every
 *   time it serves traffic is describing what it does under load, which is the
 *   thing a container is sized against.
 *
 * Returns the trend unchanged when it does not qualify, so `trend.verdict`
 * stays the raw record everywhere else.
 */
export function assessPressureVerdict(input: PressureVerdictInput): TrendResult {
  if (input.trend.verdict !== "stable" && input.trend.verdict !== "saturating") {
    return input.trend;
  }
  const pressure = assessPeakPressure({
    peaks: input.peaks,
    retainedHeapBytes: input.retainedHeapBytes,
    maxOldSpaceMb: input.maxOldSpaceMb,
  });
  if (pressure === null) {
    return input.trend;
  }
  if (!isSustained(input, pressure.class)) {
    return input.trend;
  }
  // `source` is left as measured. It names which post-GC series produced the
  // growth figure that travels with this result, and that is still true; which
  // ceiling the run approached is the peak note's job to say.
  return { ...input.trend, verdict: "pressure" };
}

const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

/**
 * One line, phrased so it never contradicts the verdict next to it. A peak is
 * the highest value *sampled*: a spike shorter than the poll interval is not
 * observed, so this is a lower bound.
 */
export function describePeakPressure(pressure: PeakPressure): string {
  if (pressure.class === "heap") {
    return (
      `peaked at ${mb(pressure.peakBytes)} heap under load against a ` +
      `${mb(pressure.heapLimitBytes)} limit (retains ${mb(pressure.retainedBytes)}) — ` +
      `the run came close to the heap ceiling even though nothing was retained; ` +
      `peaks are the highest value sampled, not a guaranteed maximum`
    );
  }
  return (
    `peaked at ${mb(pressure.peakBytes)} rss under load while retaining ` +
    `${mb(pressure.retainedBytes)} — a container sized on what it retains dies ` +
    `on what it reaches; peaks are the highest value sampled, not a guaranteed maximum`
  );
}
