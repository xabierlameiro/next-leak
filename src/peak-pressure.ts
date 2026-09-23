import { classifyTrend, type TrendResult } from "./trend.js";
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
 * OOM-killed in a 1 GB container. `assessPressureVerdict` below is where a
 * peak that keeps climbing stops being a footnote under a `✔`.
 */
export function assessPeakPressure(input: PeakPressureInput): PeakPressure | null {
  const sampled = input.peaks.filter((peak) => peak.polls > 0);
  if (sampled.length === 0) {
    return null;
  }
  const heapLimitBytes = input.maxOldSpaceMb * MB;
  const peakHeap = maxOf(sampled, (peak) => peak.heapUsed);
  const peakRss = maxOf(sampled, (peak) => peak.rss);

  if (peakHeap >= heapLimitBytes * HEAP_LIMIT_SHARE) {
    return {
      class: "heap",
      peakBytes: peakHeap,
      retainedBytes: input.retainedHeapBytes,
      heapLimitBytes,
    };
  }
  if (
    peakRss >= RSS_FLOOR_BYTES &&
    peakRss >= input.retainedHeapBytes * RSS_OVER_RETAINED
  ) {
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
 * Per-cycle growth a series of peaks must clear to count as climbing.
 *
 * Deliberately not the post-GC gate. That one is ~256 KB, because post-GC
 * samples are the quietest reading a process gives; a peak is the loudest.
 * Readings taken under load carry allocator arenas, pages not yet returned to
 * the OS and whatever the poll happened to catch mid-request, and they jitter
 * in megabytes. Judging them against the heap's gate would promote ordinary
 * noise to a verdict.
 */
export const PEAK_MIN_GROWTH_PER_CYCLE = 16 * MB;

/**
 * Net growth a series of peaks must have added, end to end.
 *
 * The per-cycle gate alone is not enough here, because the peak series has no
 * baseline row: at the default 4 cycles it offers two deltas, which is the
 * "one noisy cycle flips the verdict" case `RITUAL_DEFAULTS` chose 4 cycles to
 * avoid for the post-GC series. This is what replaces the delta the series does
 * not have — two lucky deltas are easy, 64 MB of sustained climb is not.
 */
export const PEAK_MIN_TOTAL_GROWTH = 64 * MB;

/** Reads the class of peak that `assessPeakPressure` reported on. */
const peakSeries = (
  peaks: readonly PeakSample[],
  pressureClass: PeakPressureClass
): number[] => peaks.map((peak) => (pressureClass === "heap" ? peak.heapUsed : peak.rss));

/**
 * Whether the peak series climbed, rather than merely reaching a height.
 *
 * Every cycle must have been polled. A cycle with no readings is a hole, and
 * dropping it would close the gap silently — the series would compare
 * non-adjacent cycles as if they were neighbours and could manufacture a delta
 * that no cycle produced. A run that cannot say what one cycle reached does not
 * get to claim a direction.
 */
function isClimbing(values: readonly number[], polled: boolean): boolean {
  if (!polled) {
    return false;
  }
  const first = values[1];
  const last = values.at(-1);
  if (first === undefined || last === undefined) {
    return false;
  }
  return (
    classifyTrend(values, { minGrowthPerCycle: PEAK_MIN_GROWTH_PER_CYCLE }).verdict === "leak" &&
    last - first >= PEAK_MIN_TOTAL_GROWTH
  );
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
 * Three conditions. The gates are not new: they are the pair this repo already
 * used to decide whether an RSS curve was growing, which is the same question
 * about the same kind of reading, and they now have one definition.
 *
 * - **The post-GC verdict is `stable` or `saturating`.** `leak` is already the
 *   worse news and `inconclusive` is an admission that the series did not
 *   decide — promoting *that* to an accusation would be inventing a finding out
 *   of a measurement that failed.
 * - **The peak is far enough from what the route retains to be remarked on** —
 *   `assessPeakPressure`, thresholds unchanged.
 * - **The peak series climbs**, by the ordinary classifier against the gates a
 *   reading taken under load needs. This is the condition that makes the verdict
 *   safe: a size becomes a direction. The first cycle plays the part the
 *   baseline plays for the post-GC series, so warm-up is dropped the same way,
 *   and a route that reaches its level and stays there never qualifies.
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
  const polled = input.peaks.every((peak) => peak.polls > 0);
  if (!isClimbing(peakSeries(input.peaks, pressure.class), polled)) {
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
