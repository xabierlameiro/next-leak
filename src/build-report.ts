import type { BuildRunResult } from "./build-run.js";

const MB = 1024 * 1024;

const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

/**
 * Per-page retention is a small number that carries the whole finding — the
 * difference between 0.97 and 1.0 MB per page is 75 MB over a 2500-page site,
 * so it gets a decimal place the gigabyte-scale figures do not need.
 */
const mbPrecise = (bytes: number): string => `${(bytes / MB).toFixed(2)} MB`;

const VERDICT_ICON: Record<string, string> = {
  leak: "✖",
  stable: "✔",
  inconclusive: "?",
};

function curveLine(levels: readonly number[]): string {
  return levels.map((level) => mb(level)).join(" → ");
}

function growthLine(result: BuildRunResult): string {
  const perPage =
    result.retentionPerPageBytes === null
      ? ""
      : `  (${mbPrecise(result.retentionPerPageBytes)}/page over ${result.pagesGenerated} pages)`;
  return `      grew ${mb(result.netGrowthBytes)} across the generation phase${perPage}`;
}

/**
 * Renders the build report.
 *
 * Says "worker rss" everywhere rather than "heap" or "retained": these samples
 * are resident memory with no forced collection behind them, and calling them
 * retention would borrow a precision the measurement does not have. RSS is
 * still the honest axis here — it is what a CI runner's limit is enforced
 * against and what the OOM killer reads.
 */
export function formatBuildReport(result: BuildRunResult): string {
  const lines: string[] = [`next-leak build · ${result.appDir}`, ""];

  if (result.strippedCapWarning !== null) {
    lines.push(`  ▲ ${result.strippedCapWarning}`, "");
  }

  if (result.status === "build-failed") {
    lines.push(
      `  ✖ the build failed for a reason that is not memory (exit ${result.exitCode ?? "?"})`,
      `      no memory claim is made; the build's own output follows`,
      "",
      ...result.output.trimEnd().split("\n").slice(-20).map((line) => `      ${line}`)
    );
    return lines.join("\n");
  }

  if (result.status === "cannot-sample") {
    lines.push(
      `  ✖ could not read the process table, so the build was not measured`,
      `      ${result.samplingFailure ?? "unknown reason"}`,
      `      this is not a clean run: an unreadable table and a build with no`,
      `      workers look identical from here, and only one of them is good news`
    );
    return lines.join("\n");
  }

  if (result.status === "nothing-to-measure") {
    lines.push(
      `  – no static-generation worker ran, so there was nothing to measure`,
      `      a build with no prerendered pages does not exercise this path`
    );
    return lines.join("\n");
  }

  const verdict = result.verdict ?? "inconclusive";
  const icon = VERDICT_ICON[verdict] ?? "?";
  lines.push(`  ${icon} static-generation worker  ${verdict}`);

  if (result.levels.length > 0) {
    lines.push(`      worker rss ${curveLine(result.levels)}`);
  }
  if (result.netGrowthBytes > 0) {
    lines.push(growthLine(result));
  }
  if (verdict === "inconclusive" && result.levels.length === 0) {
    lines.push(`      the build was too short to judge — not a sign of health`);
  }
  if (result.heapExhausted) {
    lines.push(
      `      the worker ran out of heap and the build died with it after ` +
        `${result.pagesGenerated ?? "?"} pages, reaching ${mb(result.peakWorkerRssBytes)}`,
      `      no per-page figure for a crashed build: the curve is truncated where`,
      `      the worker died, so any denominator would be guesswork`,
      `      that outcome is the verdict here, whatever shape the curve above has:`,
      `      raising the cap moves the wall; it does not remove it`
    );
  }
  if (result.workers.length > 1) {
    lines.push(`      ${result.workers.length} workers ran; the verdict is the worst of them`);
  }

  lines.push(
    "",
    `  peak worker rss ${mb(result.peakWorkerRssBytes)} · sampled from the process tree, so a`,
    `  spike shorter than the polling interval is not observed`
  );
  return lines.join("\n");
}
