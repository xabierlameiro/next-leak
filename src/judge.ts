import type { AbandonOrigin } from "./abandon-load.js";
import { assessConfidence, effectiveVerdict, type ConfidenceReport } from "./confidence.js";
import type { HeapSample } from "./control-server.js";
import { assessPressureVerdict, retainedAfterLoad } from "./peak-pressure.js";
import type { LoadOutcome, PeakSample, SettleOutcome } from "./ritual.js";
import { classifyMemoryTrend, minGrowthFor, type TrendResult, type TrendVerdict } from "./trend.js";

/** What a verdict is computed from: one route's post-GC samples and what surrounded them. */
export type TrendInput = {
  memorySamples: readonly HeapSample[];
  peaks: readonly PeakSample[];
  requestsPerCycle: number;
  maxOldSpaceMb: number;
  cacheDriven?: boolean;
};

export type JudgeInput = TrendInput & {
  loadOutcomes: readonly LoadOutcome[];
  settleOutcomes: readonly SettleOutcome[];
  warmupRequests?: number;
  revalidatesFromCache?: boolean;
  abandonAfterMs?: number;
  abandonFrom?: AbandonOrigin;
};

export type Judgement = {
  trend: TrendResult;
  confidence: ConfidenceReport;
  /** The verdict a reader is shown: the trend's, unless the audit withdrew it. */
  verdict: TrendVerdict;
};

/**
 * The trend a measurement earns: the post-GC classification of heap and
 * external memory, escalated to `pressure` when the peaks under load call for
 * it. The gate scales with the traffic each cycle served, so the verdict does
 * not change meaning when `--requests` does.
 */
export function judgeTrend(input: TrendInput): TrendResult {
  const minGrowthPerCycle = minGrowthFor(input.requestsPerCycle);
  return assessPressureVerdict({
    trend: classifyMemoryTrend(
      input.memorySamples.map((sample) => sample.heapUsed),
      input.memorySamples.map((sample) => sample.external),
      { minGrowthPerCycle, ...(input.cacheDriven === true && { cacheDriven: true }) }
    ),
    peaks: input.peaks,
    retainedHeapBytes: retainedAfterLoad(input.memorySamples) ?? 0,
    maxOldSpaceMb: input.maxOldSpaceMb,
  });
}

/**
 * Trend, audit and the verdict shown, from stored inputs alone. A live run and
 * a replayed corpus case go through this same function, so a case recorded by
 * an earlier version is judged by today's code.
 */
export function judgeMeasurement(input: JudgeInput): Judgement {
  const trend = judgeTrend(input);
  const confidence = auditMeasurement(trend, input);
  return { trend, confidence, verdict: effectiveVerdict({ trend, confidence }) };
}

/**
 * The audit of a trend against the evidence it came from. Graded against the
 * gate the verdict used, or the noise-floor warning describes a threshold
 * nobody applied.
 */
export function auditMeasurement(trend: TrendResult, input: JudgeInput): ConfidenceReport {
  return assessConfidence({
    trend,
    loadOutcomes: input.loadOutcomes,
    settleOutcomes: input.settleOutcomes,
    minGrowthPerCycle: minGrowthFor(input.requestsPerCycle),
    memorySamples: input.memorySamples,
    maxOldSpaceMb: input.maxOldSpaceMb,
    ...(input.warmupRequests !== undefined && { warmupRequests: input.warmupRequests }),
    ...(input.revalidatesFromCache !== undefined && {
      revalidatesFromCache: input.revalidatesFromCache,
    }),
    ...(input.abandonAfterMs !== undefined && { abandonAfterMs: input.abandonAfterMs }),
    ...(input.abandonFrom !== undefined && { abandonFrom: input.abandonFrom }),
  });
}
