import { effectiveVerdict, resolveCycles, type WarningCode } from "./confidence.js";
import { paceNote, passSecondsAt } from "./eta.js";
import type { DiscoveredRoute } from "./manifests.js";
import type { NodeBinary } from "./node-binaries.js";
import { HeapExhaustedError, RITUAL_DEFAULTS } from "./ritual.js";
import type { TrendVerdict } from "./trend.js";
import { measureRoute } from "./route-measure.js";
import type {
  MeasurementContext,
  NodeVersionResult,
  RepetitionSummary,
  RouteReport,
} from "./run-types.js";

/**
 * Why a route earns a second, longer pass — or null when the first one settles it.
 *
 * `inconclusive` means the evidence does not decide, and the report knows what
 * would: the same route, twice the cycles. Printing that command and stopping
 * asks someone whose pods are restarting to run the tool twice.
 *
 * `saturating` is the same problem wearing a verdict. Its shape requires every
 * cycle to clear the growth gate, so a decelerating curve always ends the
 * window still growing measurably — the bend is real, but where it settles is
 * outside what was measured. A longer window is the only thing that tells a
 * store that runs out from a leak that merely eased off.
 *
 * `pressure` is settled, not undecided: the run observed the peak it is
 * reporting. More cycles would only spend more traffic reaching the same
 * ceiling again.
 */
function reasonToResolve(verdict: TrendVerdict, promotedFrom?: TrendVerdict): string | null {
  switch (verdict) {
    case "inconclusive":
      return "the first pass could not call it";
    case "saturating":
      return "growth was still decelerating when the window ran out";
    case "pressure":
      // The finding is about peaks, but a curve still bending under it is the
      // shape a slow leak and a filling store share. On the vercel/next.js#97938
      // slug route, four cycles read as a bend; sixteen showed a leak.
      return promotedFrom === "saturating"
        ? "growth was still decelerating when the window ran out"
        : null;
    case "leak":
    case "stable":
      return null;
  }
}

/**
 * Measures a route `repeat` times, each from its own server, and judges it on
 * all of them.
 *
 * `resolveInconclusive` already re-measures with more cycles, but extra cycles
 * run inside the same process, so anything that varies with process startup is
 * held fixed across every one of them. The spreads that make a number
 * unpublishable are between processes: three runs of one build on
 * vercel/next.js#84648 peaked at 602, 826 and 875 MB, and a fourth was flat at
 * 39 MB.
 *
 * Each repetition runs the whole per-route measurement, its own inner
 * re-measurement included. Suppressing that would mean the repetitions are not
 * measuring what a normal run measures, so their agreement would say nothing
 * about a normal run.
 */
export async function measureRepeatedly(
  context: MeasurementContext,
  route: DiscoveredRoute,
  requestPath: string,
  index: number,
  label: string
): Promise<RouteReport> {
  const binaries = context.options.nodeBinaries ?? [];
  if (binaries.length > 1) {
    return compareNodeVersions(context, route, requestPath, index, label, binaries);
  }
  const repeat = context.options.repeat ?? 1;
  if (repeat <= 1) {
    const started = clock(context)();
    const first = await measureWithResolution(context, route, requestPath, index, label);
    return confirmBorderline(context, route, requestPath, index, label, first, {
      suffix: "",
      firstPassMs: clock(context)() - started,
    });
  }

  const passes: RouteReport[] = [];
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    context.progress(`repetition ${attempt}/${repeat} of ${label}`);
    passes.push(
      await measureWithResolution(context, route, requestPath, index, label, `-rep${attempt}`)
    );
    // A Ctrl+C mid-way keeps what has been measured rather than discarding it;
    // the aggregate then judges the repetitions that actually ran.
    if (context.options.signal?.aborted === true) {
      break;
    }
  }
  return aggregateRepetitions(passes);
}

/**
 * Measures a route once per Node binary and reports the first, with every
 * version's result beside it.
 *
 * Each binary gets the follow-ups a single run on it would: re-measurement of
 * an undecided result and confirmation of a borderline leak. On the
 * vercel/next.js#97938 reproduction (16.3.6) Node 22.23 and Node 24.22 both came
 * out `stable`, one holding about 750 MB and the other under 100, so the
 * comparison records what each held as well as its verdict.
 */
async function compareNodeVersions(
  context: MeasurementContext,
  route: DiscoveredRoute,
  requestPath: string,
  index: number,
  label: string,
  binaries: readonly NodeBinary[]
): Promise<RouteReport> {
  const reports: Array<{ binary: NodeBinary; report: RouteReport }> = [];
  for (const [position, binary] of binaries.entries()) {
    context.progress(`measuring ${label} on Node ${binary.version}`);
    const suffix = `-node${position + 1}`;
    const started = clock(context)();
    const first = await measureWithResolution(
      context,
      route,
      requestPath,
      index,
      label,
      suffix,
      binary.path
    );
    const report = await confirmBorderline(context, route, requestPath, index, label, first, {
      suffix,
      nodePath: binary.path,
      firstPassMs: clock(context)() - started,
    });
    reports.push({ binary, report });
    if (context.options.signal?.aborted === true) {
      break;
    }
  }
  const headline = reports[0]?.report;
  if (headline === undefined) {
    return { route: route.path, status: "failed", reason: "no Node version produced a result" };
  }
  if (headline.status !== "measured") {
    return headline;
  }
  return {
    ...headline,
    nodeVersions: reports.map(({ binary, report }) => nodeVersionResult(binary, report)),
  };
}

function nodeVersionResult(binary: NodeBinary, report: RouteReport): NodeVersionResult {
  if (report.status !== "measured") {
    return { version: binary.version, status: report.status };
  }
  const last = report.memorySamples.at(-1);
  return {
    version: binary.version,
    status: report.status,
    verdict: effectiveVerdict(report),
    growthPer1000Requests: report.growthPer1000Requests,
    ...(last !== undefined && { heldBytes: last.heapUsed + last.external }),
  };
}

/** Default for `confirmBudgetMs`: half an hour of second passes per run. */
export const DEFAULT_CONFIRM_BUDGET_MS = 30 * 60_000;

/**
 * Warnings about this process's sample, which a second process can read
 * differently. Left out on purpose: the `abandon-*` pair describes the load
 * shape, `near-heap-ceiling` meets the same cap next time, `cache-residency`
 * needs a different experiment rather than the same one again, and
 * `repetitions-disagree` was already repeated.
 */
const PROCESS_VARIANCE_WARNINGS: ReadonlySet<WarningCode> = new Set<WarningCode>([
  "unsettled",
  "settle-unverified",
  "load-incomplete",
  "spiky-growth",
  "near-threshold",
  "thin-evidence",
  "warm-up-baseline",
  "first-cycle-step",
]);

/** Verdicts a second process can contradict. */
const CONFIRMABLE_VERDICTS: ReadonlySet<TrendVerdict> = new Set<TrendVerdict>([
  "leak",
  "stable",
  "saturating",
]);

type Confirmation = { reason: string; budgeted: boolean };

/**
 * Why a single measurement needs a second one from a fresh server, or null.
 *
 * A leak whose growth sits in the noise band is confirmed unconditionally: it
 * is an accusation, and it is the verdict that did not hold between processes.
 * On the vercel/next.js#97938 reproduction (16.3.6, Node 22.23, 300 requests
 * per cycle) one run came out `stable` with high confidence and the next
 * `leak` at +0.50 MB per cycle against a 0.25 MB gate.
 *
 * Any other `leak`, `stable` or `saturating` with a warning about its own
 * sample is confirmed within the run's budget. The same arm gave `stable`,
 * `leak`, `saturating`, `leak` across four runs; checking only the leak side
 * left half of that flip unseen.
 */
export function confirmationFor(report: RouteReport): Confirmation | null {
  if (report.status !== "measured") {
    return null;
  }
  const verdict = effectiveVerdict(report);
  const codes = report.confidence.warnings.map((warning) => warning.code);
  if (verdict === "leak" && codes.includes("near-threshold")) {
    return { reason: "its growth barely clears the threshold", budgeted: false };
  }
  const variance = codes.filter((code) => PROCESS_VARIANCE_WARNINGS.has(code));
  if (!CONFIRMABLE_VERDICTS.has(verdict) || variance.length === 0) {
    return null;
  }
  return { reason: `low confidence (${variance.join(", ")})`, budgeted: true };
}

function clock(context: MeasurementContext): () => number {
  return context.deps.now ?? Date.now;
}

/**
 * Measures a low-confidence verdict once more from a fresh server and judges it
 * on both passes, by the same unanimity rule `--repeat` uses.
 *
 * A budgeted confirmation runs only when the first pass's wall time fits in
 * what is left of the budget, and what it really took is spent from it.
 *
 * A confirmation that fails to measure is a lost bonus, not a finding: the
 * first pass is kept. One that runs out of heap is the stronger evidence and is
 * what gets reported.
 */
async function confirmBorderline(
  context: MeasurementContext,
  route: DiscoveredRoute,
  requestPath: string,
  index: number,
  label: string,
  first: RouteReport,
  pass: { suffix: string; nodePath?: string; firstPassMs: number }
): Promise<RouteReport> {
  const confirmation = confirmationFor(first);
  if (
    confirmation === null ||
    context.options.resolveInconclusive === false ||
    context.options.signal?.aborted === true
  ) {
    return first;
  }
  const budget = context.confirmBudget;
  if (confirmation.budgeted && pass.firstPassMs > budget.remainingMs) {
    context.progress(
      `not confirming ${label} (${confirmation.reason}): the confirmation budget is spent — ` +
        `raise --confirm-budget to confirm it`
    );
    return first;
  }
  context.progress(
    `confirming ${label} from a fresh server: ${confirmation.reason}` +
      paceNote(pass.firstPassMs / 1000, "— what the first pass took")
  );
  const started = clock(context)();
  const second = await measureWithResolution(
    context,
    route,
    requestPath,
    index,
    label,
    `${pass.suffix}-confirm`,
    pass.nodePath
  );
  if (confirmation.budgeted) {
    budget.remainingMs -= clock(context)() - started;
  }
  if (second.status === "failed") {
    context.progress(`confirmation of ${label} did not measure — keeping the first pass`);
    return first;
  }
  return aggregateRepetitions([first, second]);
}

/**
 * Combines repeated measurements of one route into the verdict it earned.
 *
 * Unanimity or nothing. Taking the most severe would let one noisy repetition
 * in five accuse a healthy route, and a false accusation is the expensive
 * error; taking the majority would discard exactly the disagreement the
 * repetitions were run to find. When they disagree the honest report is that
 * the measurement did not settle, which is what `inconclusive` means and what
 * already routes to re-measurement and away from issue drafts.
 */
export function aggregateRepetitions(passes: readonly RouteReport[]): RouteReport {
  const first = passes[0];
  if (first === undefined) {
    return { route: "", status: "failed", reason: "no repetition produced a result" };
  }
  const measured = passes.filter((pass) => pass.status === "measured");
  // A repetition that failed or died of heap is not a disagreement to average
  // away — the first non-measured outcome is the finding, and it is returned
  // as it stands.
  if (measured.length !== passes.length || measured.length === 0) {
    return passes.find((pass) => pass.status !== "measured") ?? first;
  }

  const repetitions: RepetitionSummary[] = measured.map((pass) => ({
    verdict: pass.trend.verdict,
    growthPer1000Requests: (pass.trend.growthPerCycle / pass.requestsPerCycle) * 1000,
  }));
  const verdicts = [...new Set(repetitions.map((entry) => entry.verdict))];
  const winner = measured[0];
  if (winner === undefined) {
    return first;
  }
  if (verdicts.length === 1) {
    return { ...winner, repetitions };
  }

  const observed = verdicts.join(", ");
  return {
    ...winner,
    repetitions,
    confidence: {
      ...winner.confidence,
      level: "low",
      warnings: [
        ...winner.confidence.warnings,
        {
          code: "repetitions-disagree",
          detail:
            `${repetitions.length} repetitions of this route disagreed (${observed}) — ` +
            `the measurement did not settle, so no single verdict is reported`,
        },
      ],
      supersededVerdict: "inconclusive",
    },
  };
}

/** The first pass of a measurement: the defaults unless it is a repetition or on a chosen Node. */
function firstPass(
  suffix: string,
  nodePath: string | undefined
): { dirSuffix: string; nodePath?: string } | undefined {
  if (suffix === "" && nodePath === undefined) {
    return undefined;
  }
  return { dirSuffix: suffix, ...(nodePath !== undefined && { nodePath }) };
}

async function measureWithResolution(
  context: MeasurementContext,
  route: DiscoveredRoute,
  requestPath: string,
  index: number,
  label: string,
  repetitionSuffix = "",
  nodePath?: string
): Promise<RouteReport> {
  const { progress } = context;
  try {
    const asPath = requestPath === route.path ? "" : ` as ${requestPath}`;
    progress(`measuring ${label}${asPath}`);
    const first = await measureRoute(
      context,
      route,
      requestPath,
      index,
      firstPass(repetitionSuffix, nodePath)
    );
    const reason =
      first.status === "measured"
        ? reasonToResolve(effectiveVerdict(first), first.trend.promotedFrom)
        : null;
    if (first.status !== "measured" || context.options.resolveInconclusive === false || reason === null) {
      return first;
    }
    // A Ctrl+C that lands after the first pass must not start a second one:
    // the user asked the run to stop, and an inconclusive result is still a
    // result worth keeping.
    if (context.options.signal?.aborted === true) {
      return first;
    }
    const cycles = resolveCycles(context.options.cycles ?? RITUAL_DEFAULTS.cycles);
    progress(
      `re-measuring ${route.path} with ${cycles} cycles: ${reason}` +
        paceNote(passSecondsAt(first.timings, cycles), "at the pace of the first pass")
    );
    try {
      return await measureRoute(context, route, requestPath, index, {
        cycles,
        dirSuffix: `${repetitionSuffix}-resolve`,
        ...(nodePath !== undefined && { nodePath }),
      });
    } catch (cause) {
      // The second pass is a bonus, not a bet: losing it (port race lost
      // twice, the app dying under the longer run, an interrupt mid-pass)
      // must not discard the valid measurement already in hand.
      progress(
        `re-measurement of ${route.path} failed (${cause instanceof Error ? cause.message : String(cause)}) — keeping the first pass`
      );
      return first;
    }
  } catch (cause) {
    if (cause instanceof HeapExhaustedError) {
      // Not a failure: the route was measured right up to the point where it
      // stopped fitting, which is the strongest evidence a run can produce.
      progress(`leak ${label}: ${cause.message}`);
      const { evidence } = cause;
      return {
        route: route.path,
        status: "died-of-heap",
        requestPath,
        reason: cause.message,
        memorySamples: evidence.memorySamples,
        peaks: evidence.peaks,
        cyclesCompleted: evidence.cyclesCompleted,
        cyclesRequested: evidence.cyclesRequested,
        requestsPerCycle: evidence.requestsPerCycle,
      };
    }
    const failure = cause instanceof Error ? cause.message : String(cause);
    progress(`failed ${label}: ${failure}`);
    return { route: route.path, status: "failed", reason: failure };
  }
}
