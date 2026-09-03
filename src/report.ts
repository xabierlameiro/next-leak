import type { FindingAttribution } from "./attribution.js";
import type { HeapSample } from "./control-server.js";
import { classifyTrend, type TrendVerdict } from "./trend.js";
import { effectiveVerdict, resolveCycles, warrantsIssueDraft } from "./confidence.js";
import { assessPeakPressure, describePeakPressure } from "./peak-pressure.js";
import { hasPlaceholders, renderConfigSkeleton } from "./route-guidance.js";
import {
  assessUnreclaimedRetention,
  describeUnreclaimedRetention,
} from "./unreclaimed-retention.js";
import type { RouteReport, RunParameters, RunReport } from "./runner.js";

type MeasuredRouteView = Extract<RouteReport, { status: "measured" }>;

const MB = 1024 * 1024;

const formatMb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

const formatGrowth = (bytes: number): string => {
  const sign = bytes >= 0 ? "+" : "";
  return `${sign}${(bytes / MB).toFixed(2)} MB/1000 req`;
};

const VERDICT_ICON = {
  leak: "✖",
  stable: "✔",
  inconclusive: "?",
  saturating: "~",
} as const satisfies Record<TrendVerdict, string>;

/** RSS is noisier than the heap, so it needs both a trend and a real size. */
const RSS_MIN_GROWTH_PER_CYCLE = 16 * MB;
const RSS_MIN_TOTAL_GROWTH = 64 * MB;

function hasSustainedRssGrowth(memorySamples: readonly HeapSample[]): boolean {
  const rss = memorySamples.map((sample) => sample.rss);
  const first = rss[1];
  const last = rss.at(-1);
  if (first === undefined || last === undefined || rss.length < 4) {
    return false;
  }
  // Same shape rule as the heap verdict (warm-up cycle excluded), plus an
  // absolute floor so ordinary jitter never triggers the note.
  return (
    classifyTrend(rss, { minGrowthPerCycle: RSS_MIN_GROWTH_PER_CYCLE }).verdict === "leak" &&
    last - first >= RSS_MIN_TOTAL_GROWTH
  );
}

function ownerLabel(attribution: FindingAttribution): string | null {
  switch (attribution.owner) {
    case "app":
      return `${attribution.source ?? "your code"} (your code)`;
    case "dependency":
      return `${attribution.packageName ?? "a dependency"} (dependency)`;
    case "framework":
      return attribution.packageName === null
        ? "Next.js/runtime internals"
        : `${attribution.packageName} (framework)`;
    case "unattributed":
      return null;
  }
}

/**
 * An ISR route serves its cache unless the load carries the build's own
 * revalidation header. Saying so distinguishes a curve measured against a
 * re-render from one measured against a static file — the difference between a
 * verdict and a flat line that means nothing.
 */
function revalidationLines(route: MeasuredRouteView): string[] {
  return route.revalidatedEverySeconds === undefined
    ? []
    : [
        `      driven through ISR revalidation (revalidates every ` +
          `${route.revalidatedEverySeconds}s; without it the load would serve the cache)`,
      ];
}

/**
 * What a bending curve means, and what a growing cache does to a verdict.
 *
 * Both lines answer the same question from opposite sides: how much of this
 * growth is the route storing what it was asked to store. A `use cache` route
 * driven with a fresh key per request measured +603 MB/1000 requests on
 * Next 16.3.3, all of it the cache; the same route with the payload removed
 * measured +88 MB. Without saying so, the first number reads as a leak.
 */
/**
 * What repeated measurements of this route came out as.
 *
 * Printed even when every repetition agreed, because agreeing on the verdict
 * is not agreeing on the number: vercel/next.js#97424 produced the same
 * verdict across runs whose retained-per-render differed by 2.5×. Publishing
 * the midpoint of that as a measurement is the error this exists to prevent.
 */
function repetitionLines(route: MeasuredRouteView): string[] {
  const repetitions = route.repetitions;
  if (repetitions === undefined || repetitions.length < 2) {
    return [];
  }
  const rates = repetitions.map((entry) => entry.growthPer1000Requests);
  const low = Math.min(...rates);
  const high = Math.max(...rates);
  const verdicts = [...new Set(repetitions.map((entry) => entry.verdict))];
  const agreement =
    verdicts.length === 1
      ? `all ${repetitions.length} agreed on ${verdicts[0]}`
      : `they disagreed (${verdicts.join(", ")}), so no single verdict is reported`;
  const range = `${low >= 0 ? "+" : ""}${(low / MB).toFixed(2)} to ${formatGrowth(high)}`;
  return [`      across ${repetitions.length} repetitions: ${range} — ${agreement}`];
}

function cacheLines(route: MeasuredRouteView): string[] {
  const lines: string[] = [];
  if (route.trend.verdict === "saturating") {
    lines.push(
      `      growth is decelerating, not linear — the shape of a bounded store ` +
        `filling up rather than memory going missing`
    );
  }
  if (route.trend.cacheDriven === true && route.trend.growthPerCycle > 0) {
    lines.push(
      `      the load served keys this route had never cached, so some of this ` +
        `growth is cache residency; bound it with {n%N} in next-leak.config.json`
    );
  }
  return lines;
}

/**
 * Which early-disconnect experiment ran. The counters below say what the cuts
 * hit; this says what they were aiming at, and the two origins aim at
 * different leaks — mid-stream teardown against a client that was never there
 * at all.
 */
function abandonLines(route: MeasuredRouteView): string[] {
  if (route.abandon === undefined) {
    return [];
  }
  return [
    route.abandon.from === "request"
      ? `      cut ${route.abandon.afterMs}ms after the request was sent, so the ` +
        `client is gone before the response starts`
      : `      cut ${route.abandon.afterMs}ms after the first byte, so the cut ` +
        `lands mid-stream`,
  ];
}

function confidenceLines(route: MeasuredRouteView): string[] {
  const lines: string[] = [];
  // What the instrument thinks of its own reading. Silence here would be the
  // worst outcome: confident numbers from a measurement that did not hold.
  if (route.confidence.supersededVerdict !== undefined) {
    lines.push(
      `      measured ${route.trend.verdict}, withdrawn: the run did not observe ` +
        `what that verdict needs`
    );
  }
  for (const warning of route.confidence.warnings) {
    lines.push(`      ⚠ low confidence: ${warning.detail}`);
  }
  return lines;
}

function memorySourceLines(route: MeasuredRouteView, verdict: string): string[] {
  const lines: string[] = [];
  // When the verdict came from external memory the heap curve above looks
  // innocent; say which memory is actually growing.
  if (route.trend.source === "external" && verdict !== "stable") {
    const externalCurve = route.memorySamples
      .map((sample) => formatMb(sample.external))
      .join(" → ");
    lines.push(
      `      verdict comes from EXTERNAL memory (buffers, streams, fetch bodies), ` +
        `not the JS heap: external ${externalCurve}`
    );
  }
  // A flat heap with climbing RSS is a different diagnosis (allocator,
  // external buffers, fragmentation) — but only when RSS actually trends
  // upward. A first attempt used the per-1000-request rate alone and fired
  // on 5 MB of ordinary jitter during short runs.
  if (verdict === "stable" && hasSustainedRssGrowth(route.memorySamples)) {
    const rssCurve = route.memorySamples.map((sample) => formatMb(sample.rss)).join(" → ");
    lines.push(
      `      note: heap is flat but RSS grows ${formatGrowth(route.rssPer1000Requests)} — ` +
        `not a JS-heap leak (allocator, external buffers or fragmentation): RSS ${rssCurve}`
    );
  }
  return lines;
}

function diffFindingLines(route: MeasuredRouteView): string[] {
  if (route.diff === null) {
    return [];
  }
  const findings = [...route.diff.grownNodes, ...route.diff.newNodes];
  return findings.slice(0, 3).map((finding, index) => {
    const size = formatMb(finding.retainedBytes);
    const attribution = route.attribution?.findings[index];
    const owner = attribution === undefined ? null : ownerLabel(attribution);
    const detail = owner ?? (finding.retainerChain === "" ? "" : finding.retainerChain);
    return `      ↳ ${finding.kind} [${finding.nodeType}] ${finding.name} ${size}${
      detail === "" ? "" : ` — ${detail}`
    }`;
  });
}

function findingLines(route: MeasuredRouteView): string[] {
  const lines: string[] = [];
  const culprit = route.attribution === null ? null : ownerLabel(route.attribution.route);
  if (culprit !== null) {
    lines.push(`      culprit: ${culprit}`);
  }
  lines.push(...diffFindingLines(route));
  for (const signature of route.signatures) {
    const flag = signature.historical ? " (historical)" : "";
    lines.push(`      ⚠ known cause${flag}: ${signature.title} — ${signature.issue}`);
  }
  return lines;
}

/**
 * The peak is reported next to the verdict, never inside it: retention and
 * peak are different questions, and a process can be honestly `stable` and
 * still be OOM-killed for what it reached.
 */
function peakPressureLines(route: MeasuredRouteView, parameters: RunParameters): string[] {
  const retained = route.memorySamples.at(-1)?.heapUsed;
  if (retained === undefined) {
    return [];
  }
  const pressure = assessPeakPressure({
    peaks: route.peaks,
    retainedHeapBytes: retained,
    maxOldSpaceMb: parameters.maxOldSpaceMb,
  });
  return pressure === null ? [] : [`      ▲ peak pressure: ${describePeakPressure(pressure)}`];
}

/**
 * Memory held before collection is a third question again — not what survives
 * a GC, and not what the process reached under load, but what it is sitting on
 * between collections. Reported next to the verdict for the same reason.
 */
function unreclaimedLines(route: MeasuredRouteView, verdict: TrendVerdict): string[] {
  const retention = assessUnreclaimedRetention({
    unreclaimedSamples: route.unreclaimedSamples,
    memorySamples: route.memorySamples,
    verdict,
    verdictIsWellSupported: warrantsIssueDraft(route),
  });
  return retention === null
    ? []
    : [`      ▲ unreclaimed: ${describeUnreclaimedRetention(retention)}`];
}

function routeLines(route: RouteReport, parameters: RunParameters): string[] {
  if (route.status === "skipped") {
    return [`  – ${route.route}  skipped: ${route.reason}`];
  }
  if (route.status === "failed") {
    return [`  ✖ ${route.route}  failed: ${route.reason}`];
  }
  // Deliberately not `stable`: the load could not have exercised this route, so
  // the flat curve it would have produced says nothing about the app.
  if (route.status === "not-exercised") {
    return [`  – ${route.route}  not exercised: ${route.reason}`];
  }
  // A process that could not survive its own load leaked, and says so with the
  // same word as any other leak. The curve is shown truncated because it is:
  // what makes this a verdict is the death, not the slope.
  if (route.status === "died-of-heap") {
    const curve = route.memorySamples.map((sample) => formatMb(sample.heapUsed)).join(" → ");
    return [
      `  ${VERDICT_ICON.leak} ${route.route}  leak  (ran out of heap after ` +
        `${route.cyclesCompleted} of ${route.cyclesRequested} cycles)` +
        (curve === "" ? "" : `  heap ${curve}`),
      `      ${route.reason}`,
    ];
  }

  const verdict = effectiveVerdict(route);
  const curve = route.samples.map(formatMb).join(" → ");
  // A verdict the run had to go back for is not the same claim as one it got
  // first time; saying so is the difference between a number and its provenance.
  const resolved =
    route.resolvedWithCycles === undefined
      ? ""
      : `  (resolved at ${route.resolvedWithCycles} cycles)`;
  return [
    `  ${VERDICT_ICON[verdict]} ${route.route}  ${verdict}  (${formatGrowth(
      route.growthPer1000Requests
    )})  heap ${curve}${resolved}`,
    ...repetitionLines(route),
    ...revalidationLines(route),
    ...cacheLines(route),
    ...abandonLines(route),
    ...confidenceLines(route),
    ...memorySourceLines(route, verdict),
    ...peakPressureLines(route, parameters),
    ...unreclaimedLines(route, verdict),
    ...findingLines(route),
  ];
}

/** Renders the terminal report. Pure: no I/O, no colors, stable output. */
/**
 * The config that would measure the routes this run had to skip.
 *
 * Naming a file and leaving the reader to work out its shape is the difference
 * between a run they fix in ten seconds and one they abandon. Values come from
 * the build's own prerendered paths where it knows them, so the fragment often
 * needs no editing at all.
 */
function skippedGuidanceLines(report: RunReport): string[] {
  const needConfig = report.routes
    .filter((route) => route.status === "skipped" && route.reason.includes("sample params"))
    .map((route) => route.route);
  const skeleton = renderConfigSkeleton(needConfig, report.prerender);
  if (skeleton === null) {
    return [];
  }
  const editing = hasPlaceholders(skeleton)
    ? ` Replace each ${"REPLACE-ME"} with a value that exists in your app.`
    : ` The shapes come from paths your build already prerendered; \`{n}\` makes ` +
      `every request use a different one, because reusing a prerendered value ` +
      `serves the warm cache and reads as flat whatever the route retains. Use ` +
      `\`{n%200}\` instead to revisit a fixed set of 200 keys, and drop the marker ` +
      `only if the app 404s on params it never prerendered.`;
  return [
    "",
    `${needConfig.length} route(s) need sample params. Write this to ` +
      `next-leak.config.json in the app directory:${editing}`,
    ...skeleton.split("\n").map((line) => `  ${line}`),
  ];
}

/**
 * How much of the app the run actually covered.
 *
 * A listing of six routes where four were skipped reads, at a glance, like an
 * app that was measured. It was not, and the difference between "your app is
 * fine" and "we looked at a third of it" is the whole value of the number.
 */
function coverageLine(report: RunReport): string {
  const total = report.routes.length;
  // A route that died of heap was measured: it produced a verdict, and the
  // summary must not tell the reader nothing was measured on the same screen
  // where the verdict says `leak`.
  const measured = report.routes.filter(
    (route) => route.status === "measured" || route.status === "died-of-heap"
  ).length;
  if (measured === total) {
    return `measured all ${total} discovered route(s)`;
  }
  const breakdown = (["skipped", "not-exercised", "failed"] as const)
    .map((status) => ({
      status,
      count: report.routes.filter((route) => route.status === status).length,
    }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.status.replace("-", " ")}`)
    .join(", ");
  return `measured ${measured} of ${total} discovered route(s) — ${breakdown}; the rest is not a verdict about your app`;
}

/**
 * Routes that were measured but could not be attributed, and why.
 *
 * A verdict with no named retainer reads as a thin finding rather than a
 * missing one, so the count goes next to the coverage line: those routes have
 * a verdict, and the part that says what holds the memory is absent for a
 * reason worth acting on.
 */
function attributionGapLine(report: RunReport): string[] {
  const gaps = report.routes.filter(
    (route) => route.status === "measured" && route.attributionGap !== undefined
  );
  if (gaps.length === 0) {
    return [];
  }
  const names = gaps.map((route) => route.route).join(", ");
  // Two different failures, and the difference tells the reader what to try
  // next: an unreadable snapshot is on disk and too big to parse, a missing
  // one was never written because the process would not hand it over.
  const unwritten = gaps.filter(
    (route) => route.status === "measured" && route.attributionGap?.reason === "snapshot-unavailable"
  ).length;
  const cause =
    unwritten === gaps.length
      ? "their final snapshot could not be taken"
      : unwritten === 0
        ? "their snapshot could not be read"
        : "their final snapshot could not be taken or read";
  return [
    `${gaps.length} route(s) finished without attribution because ${cause} ` +
      `(${names}) — the verdicts stand, what retains the memory is unnamed`,
  ];
}

/**
 * What vouched for the instrument, on the runs where it matters.
 *
 * A page of `stable` verdicts is the one output that reads the same whether
 * the app is healthy or the measurement never worked. Saying so there is
 * useful; saying it under a leak would be noise, since a harness that just
 * caught one is not the harness in question.
 */
function harnessLine(report: RunReport): string[] {
  const measured = report.routes.filter((route) => route.status === "measured");
  if (report.harness.verified) {
    const rate = formatGrowth(report.harness.growthPer1000Requests);
    return [`harness verified this session: a planted leak measured ${rate}`];
  }
  const allStable = measured.length > 0 && measured.every((route) => effectiveVerdict(route) === "stable");
  if (!allStable) {
    return [];
  }
  return [
    "nothing verified the harness this session — a flat curve reads the same " +
      "whether nothing leaks or nothing was measured; --self-check plants a leak and proves it",
  ];
}

export function formatReport(report: RunReport): string {
  const lines = [`next-leak — ${report.appDir}`, ""];
  for (const route of report.routes) {
    lines.push(...routeLines(route, report.parameters));
  }
  lines.push(...skippedGuidanceLines(report));
  // A verdict whose gate is not printed cannot be reproduced: the same route
  // judged against a different threshold is a different measurement.
  const { minGrowthPerCycle, loadRequests, cycles, maxOldSpaceMb } = report.parameters;
  // Routes that needed a second pass were judged over more cycles than the run
  // asked for; a footer quoting only the run's figure describes neither.
  const resolvedCycles = [
    ...new Set(
      report.routes.flatMap((route) =>
        route.status === "measured" && route.resolvedWithCycles !== undefined
          ? [route.resolvedWithCycles]
          : []
      )
    ),
  ].sort((a, b) => a - b);
  const cyclesLabel =
    resolvedCycles.length === 0
      ? `${cycles} cycles`
      : `${cycles} cycles (${resolvedCycles.join(", ")} where resolved)`;
  lines.push("", coverageLine(report), ...attributionGapLine(report), ...harnessLine(report));
  lines.push(
    `judged over ${cyclesLabel} × ${loadRequests} requests, growth gate ` +
      `${(minGrowthPerCycle / 1024).toFixed(0)} KiB/cycle ` +
      `(${formatGrowth((minGrowthPerCycle / loadRequests) * 1000)}), heap cap ${maxOldSpaceMb} MB`,
    `snapshots and run.json: ${report.workDir}`,
    `report: ${report.bundle.htmlReport}`,
    ...report.bundle.issues.map((issue) => `issue draft (${issue.route}): ${issue.file}`)
  );

  const inconclusive = report.routes.filter(
    (route) => route.status === "measured" && effectiveVerdict(route) === "inconclusive"
  );
  if (inconclusive.length > 0) {
    const routeList = inconclusive.map((route) => route.route).join(",");
    const moreCycles = resolveCycles(report.parameters.cycles);
    lines.push(
      "",
      "hint: inconclusive means sustained sub-threshold growth — measure longer to resolve it:",
      `  next-leak ${report.appDir} --routes ${routeList} --cycles ${moreCycles}`
    );
  }
  return lines.join("\n");
}
