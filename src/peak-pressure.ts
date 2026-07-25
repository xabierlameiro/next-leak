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
 * Deliberately outside the verdict: `leak`/`stable`/`inconclusive` are
 * statements about retention after GC, calibrated against real leaks with no
 * false positives, and a peak is a different axis. A process that climbs to
 * 3.5 GB and hands it all back is honestly `stable` — and still OOM-killed in
 * a 1 GB container.
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
