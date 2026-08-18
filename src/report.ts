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

const VERDICT_ICON = { leak: "✖", stable: "✔", inconclusive: "?" } as const;

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
    ...revalidationLines(route),
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
    : ` The values come from paths your build already prerendered.`;
  return [
    "",
    `${needConfig.length} route(s) need sample params. Write this to ` +
      `next-leak.config.json in the app directory:${editing}`,
    ...skeleton.split("\n").map((line) => `  ${line}`),
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
  lines.push(
    "",
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
