import type { LoadOutcome, SettleOutcome } from "./ritual.js";
import type { TrendResult, TrendVerdict } from "./trend.js";

/**
 * Why a measurement may not support its own verdict.
 *
 * `unsettled`           — the heap was still moving when sampled
 * `settle-unverified`   — the idle budget was too short to check
 * `load-incomplete`     — fewer requests landed than were asked for
 * `abandon-ineffective` — early-disconnect run that disconnected nothing
 * `abandon-before-response` — cut before the server sent a byte, so the
 *   mid-stream teardown path was never reached
 * `spiky-growth`        — one cycle dominates, so the mean describes little
 * `near-threshold`      — growth barely clears the noise floor
 */
export type WarningCode =
  | "unsettled"
  | "settle-unverified"
  | "load-incomplete"
  | "abandon-ineffective"
  | "abandon-before-response"
  | "spiky-growth"
  | "near-threshold";

export type MeasurementWarning = {
  code: WarningCode;
  detail: string;
};

export type ConfidenceReport = {
  level: "high" | "low";
  warnings: MeasurementWarning[];
  /**
   * Verdict the evidence actually supports, when the measurement is not merely
   * noisy but invalid. Only ever downgrades `leak`: accusing an app of leaking
   * on evidence that does not hold is the expensive error — it sends someone
   * chasing a ghost and ends as an issue against this tool.
   */
  supersededVerdict?: TrendVerdict;
};

export type ConfidenceInput = {
  trend: TrendResult;
  loadOutcomes: readonly LoadOutcome[];
  settleOutcomes: readonly SettleOutcome[];
  /** Set when the run asked for early disconnects. */
  abandonAfterMs?: number;
  /** Threshold the verdict used, for the noise-floor check. */
  minGrowthPerCycle?: number;
};

/**
 * The verdict a route's evidence actually supports.
 *
 * `trend.verdict` stays exactly as measured — the raw record must survive — so
 * every consumer that shows a verdict to a human reads it through here
 * instead, or it will report a leak the audit already withdrew.
 *
 * Structurally typed on purpose: it lives here, next to the audit, so the
 * reporters can reach it without importing the runner (and, through it,
 * memlab) just to render a line of text.
 */
export function effectiveVerdict(report: {
  trend: TrendResult;
  confidence: ConfidenceReport;
}): TrendVerdict {
  return report.confidence.supersededVerdict ?? report.trend.verdict;
}

/**
 * Warnings that undermine the leak claim itself, rather than the precision of
 * a leak that is otherwise plain. A verdict carrying one of these is worth
 * reporting to its owner and not worth filing against anyone.
 */
const VERDICT_WEAKENING: ReadonlySet<WarningCode> = new Set([
  "near-threshold",
  "spiky-growth",
]);

/**
 * Whether a route's evidence is solid enough to draft an issue for.
 *
 * Stricter than the verdict on purpose: a draft is written to be pasted into
 * someone else's tracker, so it needs a leak that is plain, not one that
 * merely cleared the threshold. Measuring a healthy route on a real app
 * (`/server-plp`, 4 cycles × 2000 requests) produced deltas of
 * [0.9, 0.25, 0.33] MB and a draft; at 8 cycles × 5000 the same route
 * oscillated around a flat 39 MB and was plainly stable.
 */
export function warrantsIssueDraft(report: {
  trend: TrendResult;
  confidence: ConfidenceReport;
}): boolean {
  return (
    effectiveVerdict(report) === "leak" &&
    !report.confidence.warnings.some((warning) => VERDICT_WEAKENING.has(warning.code))
  );
}

const DEFAULT_MIN_GROWTH = 256 * 1024;

/** Below this share of requests landing, the load was not the one requested. */
const LOAD_COMPLETION_FLOOR = 0.99;
/** An abandonment run that disconnects less than this proves nothing about it. */
const ABANDON_EFFECTIVE_FLOOR = 0.9;
/** Share of abandonments that must land mid-stream to have tested that path. */
const MID_STREAM_FLOOR = 0.1;
/** One cycle this many times the smallest makes the mean a poor summary. */
const SPIKE_RATIO = 4;
/** Growth under this multiple of the threshold sits in the noise floor. */
const NOISE_FLOOR_MULTIPLE = 2;

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
const pct = (part: number, whole: number): string =>
  `${((part / whole) * 100).toFixed(1)}%`;

function settleWarnings(outcomes: readonly SettleOutcome[]): MeasurementWarning[] {
  const warnings: MeasurementWarning[] = [];
  const moving = outcomes.filter((outcome) => outcome.status === "moving");
  if (moving.length > 0) {
    warnings.push({
      code: "unsettled",
      detail:
        `the heap never held steady before sampling on ` +
        `${moving.map((outcome) => outcome.phase).join(", ")} — ` +
        `raise --idle-ms so post-load transients finish draining`,
    });
  }
  const unverified = outcomes.filter((outcome) => outcome.status === "unknown");
  if (unverified.length > 0) {
    warnings.push({
      code: "settle-unverified",
      detail:
        `the idle budget was too short to check whether the heap had settled on ` +
        `${unverified.map((outcome) => outcome.phase).join(", ")} — the samples ` +
        `may include post-load transients`,
    });
  }
  return warnings;
}

function abandonmentWarnings(outcome: LoadOutcome): MeasurementWarning[] {
  const abandoned = outcome.abandoned ?? 0;
  if (outcome.sent > 0 && abandoned < outcome.sent * ABANDON_EFFECTIVE_FLOOR) {
    return [{
      code: "abandon-ineffective",
      detail:
        `${outcome.phase} disconnected early on only ${abandoned} of ` +
        `${outcome.sent} requests (${pct(abandoned, outcome.sent)}) — ` +
        `the early-disconnect path was largely not exercised`,
    }];
  }
  // Abandoning every request still proves nothing about stream teardown if
  // the server never got a byte out first. Measuring #94919 hit exactly
  // this: 1500/1500 abandoned, 1 of them mid-stream, and without saying so
  // the run reads as a clean test of a path it never touched.
  const midStream = outcome.abandonedMidStream ?? 0;
  if (abandoned > 0 && midStream < abandoned * MID_STREAM_FLOOR) {
    return [{
      code: "abandon-before-response",
      detail:
        `${outcome.phase} cut ${abandoned} requests before the server sent ` +
        `anything (${midStream} mid-stream) — this tested pre-response ` +
        `disconnects, not mid-stream teardown; raise abandonAfterMs above ` +
        `the route's time-to-first-byte`,
    }];
  }
  return [];
}

function loadWarnings(
  outcomes: readonly LoadOutcome[],
  abandonAfterMs: number | undefined
): MeasurementWarning[] {
  const warnings: MeasurementWarning[] = [];
  for (const outcome of outcomes) {
    if (abandonAfterMs !== undefined) {
      warnings.push(...abandonmentWarnings(outcome));
      continue;
    }
    const landed = outcome.ok2xx ?? 0;
    if (outcome.sent > 0 && landed < outcome.sent * LOAD_COMPLETION_FLOOR) {
      warnings.push({
        code: "load-incomplete",
        detail:
          `${outcome.phase} landed ${landed} of ${outcome.sent} requests ` +
          `(${pct(landed, outcome.sent)}) — the route saw less traffic than reported`,
      });
    }
  }
  return warnings;
}

function growthShapeWarnings(trend: TrendResult): MeasurementWarning[] {
  const judged = trend.verdict === "leak" || trend.verdict === "inconclusive";
  if (!judged || trend.deltas.length < 2) {
    return [];
  }
  const positive = trend.deltas.filter((delta) => delta > 0);
  if (positive.length !== trend.deltas.length) {
    return [];
  }
  const smallest = Math.min(...positive);
  const largest = Math.max(...positive);
  if (largest <= smallest * SPIKE_RATIO) {
    return [];
  }
  return [{
    code: "spiky-growth",
    detail:
      `one cycle grew ${mb(largest)} and another ${mb(smallest)} — ` +
      `the mean of ${mb(trend.growthPerCycle)}/cycle summarizes ` +
      `an uneven series; measure more cycles before quoting it`,
  }];
}

function noiseFloorWarnings(trend: TrendResult, minGrowth: number): MeasurementWarning[] {
  if (trend.verdict !== "leak" || trend.growthPerCycle >= minGrowth * NOISE_FLOOR_MULTIPLE) {
    return [];
  }
  return [{
    code: "near-threshold",
    detail:
      `growth of ${mb(trend.growthPerCycle)}/cycle barely clears the ` +
      `${mb(minGrowth)} threshold — raise --load-requests so the signal ` +
      `outgrows the noise`,
  }];
}

/**
 * Invalidity, not noise: the measurement did not observe what it claims to.
 * Only a leak verdict is withdrawn — a stable one keeps its warnings, since
 * silently missing a leak costs the user less than a false accusation. And
 * only an *observed* moving heap invalidates: "unverified" means the run
 * never looked, which is a reason to say so, not to overturn the reading.
 */
function isVerdictInvalid(input: ConfidenceInput): boolean {
  if (input.trend.verdict !== "leak") {
    return false;
  }
  const neverSettled =
    input.settleOutcomes.length > 0 &&
    input.settleOutcomes.every((outcome) => outcome.status === "moving");
  const abandonedNothing =
    input.abandonAfterMs !== undefined &&
    input.loadOutcomes.length > 0 &&
    input.loadOutcomes.every((outcome) => (outcome.abandoned ?? 0) === 0);
  return neverSettled || abandonedNothing;
}

/**
 * Audits a route measurement against its own evidence.
 *
 * A leak detector is an instrument, and a miscalibrated instrument does not
 * fail loudly — it reports confident, wrong numbers. Two implementations of
 * early disconnects shipped in this repo that abandoned nothing, and both
 * produced a verdict indistinguishable from the correct one; only the audit
 * trail caught them. This turns that trail into a check that runs every time.
 */
export function assessConfidence(input: ConfidenceInput): ConfidenceReport {
  const minGrowth = input.minGrowthPerCycle ?? DEFAULT_MIN_GROWTH;
  const warnings = [
    ...settleWarnings(input.settleOutcomes),
    ...loadWarnings(input.loadOutcomes, input.abandonAfterMs),
    ...growthShapeWarnings(input.trend),
    ...noiseFloorWarnings(input.trend, minGrowth),
  ];

  return {
    level: warnings.length === 0 ? "high" : "low",
    warnings,
    ...(isVerdictInvalid(input) && { supersededVerdict: "inconclusive" as TrendVerdict }),
  };
}
