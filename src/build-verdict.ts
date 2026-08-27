import { classifyTrend, type TrendResult } from "./trend.js";

export type BuildSample = {
  /** Milliseconds since the build started. */
  atMs: number;
  rssBytes: number;
};

/**
 * Segments the sampling window into equal slices and takes each slice's last
 * reading.
 *
 * A build has no cycles. Its only natural unit of work is a page, and pages are
 * not observable from outside the worker — so the window is divided by time
 * instead, which yields a series with the shape semantics the trend classifier
 * already reads: one level per unit of work. Taking the last sample of each
 * slice rather than the mean keeps a climb a climb; averaging would flatten the
 * end of every segment into its start.
 */
export function segmentSamples(samples: readonly BuildSample[], segments: number): number[] {
  // Fewer readings than segments cannot fill them: the same reading would
  // land in several slices and the repeats would read as a plateau, which is
  // a healthy shape invented out of missing data.
  if (segments <= 0 || samples.length < segments) {
    return [];
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) {
    return [];
  }
  const span = last.atMs - first.atMs;
  if (span <= 0) {
    return [];
  }
  const levels: number[] = [];
  for (let segment = 1; segment <= segments; segment += 1) {
    const until = first.atMs + (span * segment) / segments;
    let level: number | undefined;
    for (const sample of samples) {
      if (sample.atMs <= until) {
        level = sample.rssBytes;
      }
    }
    if (level !== undefined) {
      levels.push(level);
    }
  }
  return levels;
}

/**
 * Segments a build needs before its curve can be judged.
 *
 * The classifier drops the first delta as warm-up and wants at least three
 * more, and a worker's first segment is genuinely warm-up: module loading and
 * JIT, the same reason the runtime ritual discards its baseline delta.
 */
export const BUILD_SEGMENTS = 6;

export type BuildTrend = {
  trend: TrendResult;
  /** The segmented levels the verdict was read from. */
  levels: number[];
};

/**
 * Per-segment growth a build worker must clear to count as retaining.
 *
 * Not the runtime gate. That one is the noise floor of a *post-GC heap* sample,
 * 256 KiB, and it does not describe RSS: a build worker doing legitimate work
 * moves tens of megabytes between readings through allocator behaviour alone,
 * with nothing retained.
 *
 * Anchored on two builds of the same project, same heap cap, 2026-08-17:
 * 16.2.12 stayed flat (428 → 530 MB, largest segment delta 17 MB) while 16.3.1
 * climbed 1070 → 2960 MB and then OOMed, ~315 MB per segment. 32 MB is roughly
 * twice the largest healthy delta and an order of magnitude below the leaking
 * one. The consequence to be honest about: a build retaining less than this per
 * segment reads as stable — and one retaining less than this does not OOM.
 */
export const BUILD_GROWTH_GATE_BYTES = 32 * 1024 * 1024;

/** Classifies a worker's resident-memory curve. */
export function classifyBuildSamples(samples: readonly BuildSample[]): BuildTrend {
  const levels = segmentSamples(samples, BUILD_SEGMENTS);
  return {
    trend: classifyTrend(levels, { minGrowthPerCycle: BUILD_GROWTH_GATE_BYTES }),
    levels,
  };
}

/** Growth across the analyzed window, in bytes. */
export function netGrowthOf(levels: readonly number[]): number {
  const first = levels[1] ?? levels[0];
  const last = levels[levels.length - 1];
  if (first === undefined || last === undefined) {
    return 0;
  }
  return last - first;
}

/**
 * Retention per page generated.
 *
 * Null when the page count is unknown: a growth figure with an invented
 * denominator is worse than no figure, and this is the number people quote.
 */
export function retentionPerPage(
  levels: readonly number[],
  pagesGenerated: number | null
): number | null {
  if (pagesGenerated === null || pagesGenerated <= 0) {
    return null;
  }
  const growth = netGrowthOf(levels);
  return growth <= 0 ? null : growth / pagesGenerated;
}

/**
 * The heap cap Next removes from the worker's environment.
 *
 * `lib/worker.js` deletes `max-old-space-size` and `max_old_space_size` from
 * `NODE_OPTIONS` when it spawns an isolated-memory worker, so the flag every
 * OOM guide recommends never reaches the process that runs out of memory.
 * Verified by measurement on the #97464 reproduction: a build capped at 50 MB
 * with `--max-old-space-size` completes, while `--max-heap-size=50` kills it in
 * 374 ms.
 */
export function strippedHeapCap(nodeOptions: string | undefined): string | null {
  if (nodeOptions === undefined) {
    return null;
  }
  const match = /--max[-_]old[-_]space[-_]size[= ]\s*(\d+)/.exec(nodeOptions);
  if (match === null) {
    return null;
  }
  const value = match[1] ?? "";
  return (
    `NODE_OPTIONS sets --max-old-space-size=${value}, which Next strips from the ` +
    `static-generation worker's environment — the worker never sees it. Set ` +
    `NODE_OPTIONS=--max-heap-size=${value} instead, which survives.`
  );
}

const HEAP_DEATH_MARKERS = [
  "JavaScript heap out of memory",
  "Reached heap limit",
  "Ineffective mark-compacts near heap limit",
];

/** Whether build output carries a V8 heap-limit fatal error. */
export function diedOfHeapExhaustion(output: string): boolean {
  return HEAP_DEATH_MARKERS.some((marker) => output.includes(marker));
}

/**
 * How many pages the build generated, read from its own progress line.
 *
 * Next prints `Generating static pages (1234/2504)`; the largest first number
 * seen is how far it got, which is the useful figure whether it finished or
 * died. Null when the build never printed one — an invented denominator would
 * turn an unknown into a wrong number.
 */
export function pagesGeneratedFrom(output: string): number | null {
  let furthest: number | null = null;
  for (const line of output.split("\n")) {
    if (!line.includes("static pages")) {
      continue;
    }
    for (const match of line.matchAll(/\((\d+)\/(\d+)\)/g)) {
      const done = Number(match[1]);
      if (Number.isFinite(done) && (furthest === null || done > furthest)) {
        furthest = done;
      }
    }
  }
  return furthest;
}
