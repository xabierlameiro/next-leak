import type { AbandonOrigin } from "./abandon-load.js";
import type { HeapSample } from "./control-server.js";
import type { LoadOutcome, SettleOutcome } from "./ritual.js";
import { MIN_GROWTH_NOISE_FLOOR, type TrendResult, type TrendVerdict } from "./trend.js";

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
 * `thin-evidence`       — a leak called on too few cycles for its size
 * `near-heap-ceiling`   — the heap approached the cap the process ran under,
 *   so the curve was measured against a ceiling instead of running free
 * `warm-up-baseline`    — the baseline sat far above the level the cycles
 *   settled at, so it carries warm-up's own retention rather than the app's
 *   resting size
 */
export type WarningCode =
  | "unsettled"
  | "settle-unverified"
  | "load-incomplete"
  | "abandon-ineffective"
  | "abandon-before-response"
  | "spiky-growth"
  | "near-threshold"
  | "thin-evidence"
  | "near-heap-ceiling"
  | "warm-up-baseline"
  /**
   * Repeated measurements of the same route did not agree.
   *
   * More cycles watch one process for longer; repetitions watch different
   * ones, and that is where the spread lives — vercel/next.js#84648 gave 602,
   * 826 and 875 MB on three runs of one build and 39 MB on a fourth. A verdict
   * a second run contradicts is not a verdict.
   */
  | "repetitions-disagree";

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
  /** Which deadline origin those disconnects used. Defaults to `first-byte`. */
  abandonFrom?: AbandonOrigin;
  /** Threshold the verdict used, for the noise-floor check. */
  minGrowthPerCycle?: number;
  /** Post-GC samples, for the heap-ceiling check. */
  memorySamples?: readonly HeapSample[];
  /** Old-space cap the measured process ran under (MB). */
  maxOldSpaceMb?: number;
  /** Warm-up requests the run sent before the baseline, for the warm-up check. */
  warmupRequests?: number;
};

/**
 * Cycles a re-measurement uses when a verdict came back `inconclusive` — the
 * same figure the report's manual re-run hint prints. One definition, imported
 * by both, so the tool can never recommend one number and use another.
 */
export const resolveCycles = (cycles: number): number => Math.max(cycles * 2, 6);

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
  "thin-evidence",
  "repetitions-disagree",
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

function abandonmentWarnings(
  outcome: LoadOutcome,
  abandonFrom: AbandonOrigin | undefined
): MeasurementWarning[] {
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
  //
  // The remedy used to be "raise abandonAfterMs above time-to-first-byte".
  // That advice was unfollowable — under load there is no such value — and it
  // is now moot: the deadline starts at the first byte. Landing here means the
  // route sent nothing at all within the first-byte budget.
  // Under the request origin the cut is meant to land before the response
  // exists — that is the whole reason a route selects it. Reporting the
  // intended outcome as a shortfall would train the reader to ignore the one
  // warning that still matters here, which is the effectiveness check above.
  if (abandonFrom === "request") {
    return [];
  }
  const midStream = outcome.abandonedMidStream ?? 0;
  if (abandoned > 0 && midStream < abandoned * MID_STREAM_FLOOR) {
    return [{
      code: "abandon-before-response",
      detail:
        `${outcome.phase} cut ${abandoned} requests that never produced a ` +
        `byte (${midStream} mid-stream) — the route did not start responding, ` +
        `so mid-stream teardown was not exercised; the route is saturated or ` +
        `hung at this load, not mistuned`,
    }];
  }
  return [];
}

function loadWarnings(
  outcomes: readonly LoadOutcome[],
  abandonAfterMs: number | undefined,
  abandonFrom: AbandonOrigin | undefined
): MeasurementWarning[] {
  const warnings: MeasurementWarning[] = [];
  for (const outcome of outcomes) {
    if (abandonAfterMs !== undefined) {
      warnings.push(...abandonmentWarnings(outcome, abandonFrom));
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

/** Share of the old-space cap a post-GC heap may reach before it is news. */
const HEAP_CEILING_RATIO = 0.7;

/**
 * Whether the run had room to grow.
 *
 * Post-GC retained heap is measured after a forced mark-compact, so the cap
 * does not distort *what is retained*. What it does distort is how far the
 * curve was allowed to go: a route that would have kept climbing gets clipped
 * by the ceiling, or dies as an OOM the report attributes to the app. The
 * measured #84884 reproduction peaked at 369 MB under the 512 MB default —
 * 72% of the way there, and nothing said so.
 */
function heapCeilingWarnings(input: ConfidenceInput): MeasurementWarning[] {
  const samples = input.memorySamples;
  const capMb = input.maxOldSpaceMb;
  // The length check is deliberately redundant: `Math.max()` of an empty
  // spread is -Infinity, which would clear every threshold on its own. That is
  // accidental correctness, and the mutation suite reports this clause as an
  // equivalent mutant precisely because of it — keep it anyway.
  if (samples === undefined || capMb === undefined || samples.length === 0) {
    return [];
  }
  const peak = Math.max(...samples.map((sample) => sample.heapUsed));
  const capBytes = capMb * 1024 * 1024;
  if (peak < capBytes * HEAP_CEILING_RATIO) {
    return [];
  }
  return [{
    code: "near-heap-ceiling",
    detail:
      `the heap peaked at ${mb(peak)} against a ${capMb} MB cap ` +
      `(${pct(peak, capBytes)}) — the curve may have been clipped by the ` +
      `ceiling rather than by the app; re-run with a larger --max-old-space`,
  }];
}

/**
 * Share of the baseline that has to drain away before it looks like warm-up's
 * memory rather than the app's resting size.
 *
 * Warm-up exists to load modules and warm the JIT — work that does not repeat.
 * On an app whose caches key on the request it also fills those caches, and the
 * baseline then measures the warm-up rather than the app. Measured on the
 * vercel/next.js#97424 reproduction: baseline 861.7 MB against 129.4 MB on the
 * very next cycle, so 85% of the baseline was warm-up. The healthy fixture
 * drops 0.2 MB of 7.3 (3%), and the #96533 app 0.8 MB of 27.1 (3%).
 */
const WARM_UP_BASELINE_SHARE = 0.5;

/**
 * And an absolute floor, so a tiny app dropping most of a tiny baseline stays
 * quiet. A run that sheds less than this between the baseline and the first
 * cycle has nothing worth re-running for.
 */
const WARM_UP_BASELINE_FLOOR_BYTES = 16 * 1024 * 1024;

/**
 * Whether the baseline carries memory the warm-up put there.
 *
 * Reported, never corrected: moving the baseline would hide the problem, and
 * changing the default warm-up size would change every existing verdict. The
 * user gets the fact and the knob (`--warmup`).
 */
function warmUpBaselineWarnings(input: ConfidenceInput): MeasurementWarning[] {
  const samples = input.memorySamples;
  const baseline = samples?.[0]?.heapUsed;
  const firstCycle = samples?.[1]?.heapUsed;
  if (baseline === undefined || firstCycle === undefined) {
    return [];
  }
  const drained = baseline - firstCycle;
  if (drained < WARM_UP_BASELINE_FLOOR_BYTES || drained < baseline * WARM_UP_BASELINE_SHARE) {
    return [];
  }
  const warmup =
    input.warmupRequests === undefined ? "" : ` (${input.warmupRequests} warm-up requests)`;
  return [{
    code: "warm-up-baseline",
    detail:
      `the baseline was ${mb(baseline)} and the first cycle ${mb(firstCycle)} — ` +
      `${pct(drained, baseline)} of it drained away, so it carries warm-up's own ` +
      `retention rather than the app's resting size${warmup}; every delta is ` +
      `measured from that inflated start. Lower --warmup if the app caches per request`,
  }];
}

/**
 * Invalidity, not noise: the measurement did not observe what it claims to.
 * Only a leak verdict is withdrawn — a stable one keeps its warnings, since
 * silently missing a leak costs the user less than a false accusation. And
 * only an *observed* moving heap invalidates: "unverified" means the run
 * never looked, which is a reason to say so, not to overturn the reading.
 */
/**
 * Deltas below which a leak verdict has to be large to be believed.
 *
 * Four cycles leave three deltas after the warm-up one is dropped, and three
 * points of a heap oscillating a couple of MB around its plateau satisfy both
 * leak shapes. Measured on 2026-07-26 against the app from vercel/next.js#94919
 * with `--quick`: three of nine healthy routes came back `leak`, two of them
 * with an issue draft, and a repeat run returned `stable` for two of the three.
 */
const THIN_EVIDENCE_MIN_DELTAS = 5;

/**
 * What every cycle must grow, as a multiple of the gate, for a leak called on
 * thin evidence to stand.
 *
 * The mean is the wrong test here: the false positives averaged 4.1-8.2x the
 * gate, and so does the bundled leaky fixture, which retains 8 KB per request
 * by construction. What separates them is the *worst* cycle. The false
 * positives all contain a cycle that gave memory back or stood still
 * (-0.03 MB, 0.00 MB, +0.08 MB); a real leak measured on three deltas grows
 * every one of them — the fixture by ~2.4 MB (9x), #94919 by ~25 MB (99x).
 */
const THIN_EVIDENCE_MIN_DELTA_RATIO = 4;

function isThinEvidence(trend: TrendResult, minGrowth: number): boolean {
  if (trend.deltas.length >= THIN_EVIDENCE_MIN_DELTAS || trend.deltas.length === 0) {
    return false;
  }
  const smallest = Math.min(...trend.deltas);
  return smallest < minGrowth * THIN_EVIDENCE_MIN_DELTA_RATIO;
}

function thinEvidenceWarnings(
  trend: TrendResult,
  minGrowth: number
): MeasurementWarning[] {
  if (trend.verdict !== "leak" || !isThinEvidence(trend, minGrowth)) {
    return [];
  }
  const smallest = Math.min(...trend.deltas);
  return [{
    code: "thin-evidence",
    detail:
      `judged on ${trend.deltas.length} cycles, and its weakest grew ` +
      `${mb(smallest)} against a ${mb(minGrowth)} gate — on that few cycles ` +
      `ordinary oscillation reaches that, and a repeat run often disagrees; ` +
      `measure more cycles to resolve it`,
  }];
}

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
  const thinEvidence = isThinEvidence(
    input.trend,
    input.minGrowthPerCycle ?? MIN_GROWTH_NOISE_FLOOR
  );
  return neverSettled || abandonedNothing || thinEvidence;
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
  const minGrowth = input.minGrowthPerCycle ?? MIN_GROWTH_NOISE_FLOOR;
  const warnings = [
    ...settleWarnings(input.settleOutcomes),
    ...loadWarnings(input.loadOutcomes, input.abandonAfterMs, input.abandonFrom),
    ...growthShapeWarnings(input.trend),
    ...noiseFloorWarnings(input.trend, minGrowth),
    ...thinEvidenceWarnings(input.trend, minGrowth),
    ...heapCeilingWarnings(input),
    ...warmUpBaselineWarnings(input),
  ];

  return {
    level: warnings.length === 0 ? "high" : "low",
    warnings,
    ...(isVerdictInvalid(input) && { supersededVerdict: "inconclusive" as TrendVerdict }),
  };
}
