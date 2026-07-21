import type { FindingAttribution } from "./attribution.js";
import type { HeapSample } from "./control-server.js";
import { classifyTrend } from "./trend.js";
import { effectiveVerdict } from "./confidence.js";
import type { RouteReport, RunReport } from "./runner.js";

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
  const last = rss[rss.length - 1];
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

function routeLines(route: RouteReport): string[] {
  if (route.status === "skipped") {
    return [`  – ${route.route}  skipped: ${route.reason}`];
  }
  if (route.status === "failed") {
    return [`  ✖ ${route.route}  failed: ${route.reason}`];
  }

  const verdict = effectiveVerdict(route);
  const curve = route.samples.map(formatMb).join(" → ");
  return [
    `  ${VERDICT_ICON[verdict]} ${route.route}  ${verdict}  (${formatGrowth(
      route.growthPer1000Requests
    )})  heap ${curve}`,
    ...confidenceLines(route),
    ...memorySourceLines(route, verdict),
    ...findingLines(route),
  ];
}

/** Renders the terminal report. Pure: no I/O, no colors, stable output. */
export function formatReport(report: RunReport): string {
  const lines = [`next-leak — ${report.appDir}`, ""];
  for (const route of report.routes) {
    lines.push(...routeLines(route));
  }
  lines.push("", `snapshots and run.json: ${report.workDir}`);
  lines.push(`report: ${report.bundle.htmlReport}`);
  for (const issue of report.bundle.issues) {
    lines.push(`issue draft (${issue.route}): ${issue.file}`);
  }

  const inconclusive = report.routes.filter(
    (route) => route.status === "measured" && effectiveVerdict(route) === "inconclusive"
  );
  if (inconclusive.length > 0) {
    const routeList = inconclusive.map((route) => route.route).join(",");
    const moreCycles = Math.max(report.parameters.cycles * 2, 6);
    lines.push(
      "",
      "hint: inconclusive means sustained sub-threshold growth — measure longer to resolve it:",
      `  next-leak ${report.appDir} --routes ${routeList} --cycles ${moreCycles}`
    );
  }
  return lines.join("\n");
}
