export type TrendVerdict = "leak" | "stable" | "inconclusive";

export type TrendResult = {
  verdict: TrendVerdict;
  /** Mean retained-heap growth per cycle (bytes) over the analyzed window. */
  growthPerCycle: number;
  /** Per-cycle deltas (bytes) after dropping the warm-up cycle. */
  deltas: number[];
  /**
   * Which memory produced the verdict. A Node process can leak in three
   * places and only one of them is the JS heap: `external`/`arrayBuffers`
   * hold fetch bodies, streams and Buffers, and can OOM a process while the
   * heap stays flat (vercel/next.js#92287 reports 4.3 GB of arrayBuffers
   * against a healthy heap). Reporting the heap alone would call that
   * "stable".
   */
  source?: "heap" | "external";
};

export type TrendOptions = {
  /** Minimum per-cycle growth (bytes) considered leak-like. Default: 256 KiB. */
  minGrowthPerCycle?: number;
};

const DEFAULT_MIN_GROWTH = 256 * 1024;

/** A stepwise leak needs this many cycles above the threshold to count. */
const STEPWISE_MIN_GROWING_CYCLES = 2;
/** Share of net growth a series may give back and still count as monotonic. */
const STEPWISE_MAX_DRAWDOWN_RATIO = 0.1;

/**
 * Largest give-back from a running peak, over the post-warm-up window.
 *
 * This is what separates a plateau from a pause. A healthy route oscillates
 * around its level and hands back a real share of what it took (22–33% of net
 * growth, measured across the validation set); a leak that stalls for a cycle
 * hands back nothing and resumes from where it stopped.
 */
function maxDrawdown(samples: readonly number[]): number {
  let peak = samples[1] ?? 0;
  let worst = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    peak = Math.max(peak, value);
    worst = Math.max(worst, peak - value);
  }
  return worst;
}

/**
 * Growth that climbs in steps instead of every cycle.
 *
 * Judging only per-cycle deltas made a single flat cycle enough to call a
 * route stable, which is exactly wrong for leaks that grow in batches — a
 * cache doubling its backing store, or a registry flushed on a schedule.
 * vercel/next.js#95094 ("stepwise heap growth") took a measured heap from
 * 28.7 MB to 139 MB across 8 cycles and was reported `stable`, because three
 * of its seven deltas happened to land on zero.
 */
function isStepwiseGrowth(
  samples: readonly number[],
  deltas: readonly number[],
  growingCycles: number,
  mean: number,
  minGrowth: number
): boolean {
  if (growingCycles < STEPWISE_MIN_GROWING_CYCLES || mean < minGrowth) {
    return false;
  }
  const netGrowth = deltas.reduce((sum, delta) => sum + delta, 0);
  if (netGrowth <= 0) {
    return false;
  }
  return maxDrawdown(samples) <= netGrowth * STEPWISE_MAX_DRAWDOWN_RATIO;
}

/**
 * Classifies a series of post-GC retained-heap samples — baseline first, then
 * one sample per load cycle — as leaking or stable.
 *
 * The baseline→cycle-1 delta is excluded from the verdict: measurements on
 * healthy routes show it is dominated by one-time engine warm-up (JIT code,
 * lazy caches) even after an HTTP-level warm-up phase. A leak must keep
 * growing across the remaining cycles; warm-up flattens out.
 */
export function classifyTrend(samples: readonly number[], options: TrendOptions = {}): TrendResult {
  const minGrowth = options.minGrowthPerCycle ?? DEFAULT_MIN_GROWTH;

  if (samples.length < 4) {
    return { verdict: "inconclusive", growthPerCycle: 0, deltas: [] };
  }

  const deltas: number[] = [];
  for (let i = 2; i < samples.length; i += 1) {
    const current = samples[i];
    const previous = samples[i - 1];
    if (current === undefined || previous === undefined) {
      return { verdict: "inconclusive", growthPerCycle: 0, deltas: [] };
    }
    deltas.push(current - previous);
  }

  const mean = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
  const allGrow = deltas.every((d) => d >= minGrowth);
  const anyFlatOrDown = deltas.some((d) => d <= 0);
  const growingCycles = deltas.filter((d) => d >= minGrowth).length;

  // Post-GC samples of a real leak grow every cycle; a healthy route
  // oscillates around its plateau, so at least one delta goes flat or
  // negative (observed on every healthy phase-0 run). Exactly three outcomes:
  //   leak         — every cycle grows by at least the threshold
  //   stable       — some cycle went flat/down, or the mean is below the
  //                  threshold (small consistent drift is measurement noise)
  //   inconclusive — never flat, no cycle reaches the threshold alone, yet
  //                  the mean does: too close to call, measure more cycles
  if (allGrow) {
    return { verdict: "leak", growthPerCycle: mean, deltas, source: "heap" };
  }
  if (isStepwiseGrowth(samples, deltas, growingCycles, mean, minGrowth)) {
    return { verdict: "leak", growthPerCycle: mean, deltas, source: "heap" };
  }
  if (anyFlatOrDown || mean < minGrowth) {
    return { verdict: "stable", growthPerCycle: mean, deltas, source: "heap" };
  }
  return { verdict: "inconclusive", growthPerCycle: mean, deltas, source: "heap" };
}

/**
 * Verdict over both the JS heap and external memory, taking the worse of the
 * two. External memory (`external`, which includes `arrayBuffers`) holds
 * fetch bodies, streams and Buffers; a process can be killed by OOM with a
 * perfectly flat heap, so judging the heap alone answers the wrong question.
 */
export function classifyMemoryTrend(
  heapSamples: readonly number[],
  externalSamples: readonly number[],
  options: TrendOptions = {}
): TrendResult {
  const heap = classifyTrend(heapSamples, options);
  const external = classifyTrend(externalSamples, options);
  const severity: Record<TrendVerdict, number> = { leak: 0, inconclusive: 1, stable: 2 };

  if (severity[external.verdict] < severity[heap.verdict]) {
    return { ...external, source: "external" };
  }
  return heap;
}
