import { effectiveVerdict } from "./confidence.js";
import type { RouteReport, RunReport } from "./runner.js";

const MB = 1024 * 1024;

const VERDICT_COLOR = { leak: "#c0392b", stable: "#27ae60", inconclusive: "#e67e22" } as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline-SVG line chart of post-GC heap samples. No scripts, no assets. */
function heapCurveSvg(samples: number[], color: string): string {
  const width = 320;
  const height = 96;
  const pad = 8;
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const span = Math.max(max - min, 1);
  const points = samples
    .map((sample, index) => {
      const x = pad + (index * (width - 2 * pad)) / Math.max(samples.length - 1, 1);
      const y = height - pad - ((sample - min) * (height - 2 * pad)) / span;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const labels =
    `<text x="${pad}" y="10" class="axis">${(max / MB).toFixed(1)} MB</text>` +
    `<text x="${pad}" y="${height - 1}" class="axis">${(min / MB).toFixed(1)} MB</text>`;
  return (
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
    `${labels}<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/>` +
    samples
      .map((sample, index) => {
        const x = pad + (index * (width - 2 * pad)) / Math.max(samples.length - 1, 1);
        const y = height - pad - ((sample - min) * (height - 2 * pad)) / span;
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="${color}"/>`;
      })
      .join("") +
    `</svg>`
  );
}

function measuredSection(route: RouteReport): string {
  if (route.status !== "measured") {
    return "";
  }
  const verdict = effectiveVerdict(route);
  const color = VERDICT_COLOR[verdict];
  const withdrawn =
    route.confidence.supersededVerdict === undefined
      ? ""
      : `<p class="warn">Measured <strong>${route.trend.verdict}</strong>, withdrawn: ` +
        `the run did not observe what that verdict needs.</p>`;
  const warnings =
    route.confidence.warnings.length === 0
      ? ""
      : `<ul class="warn">${route.confidence.warnings
          .map((warning) => `<li>${escapeHtml(warning.detail)}</li>`)
          .join("")}</ul>`;
  const curve = route.samples.map((sample) => (sample / MB).toFixed(1)).join(" → ");
  const findings = [...(route.diff?.grownNodes ?? []), ...(route.diff?.newNodes ?? [])];
  const findingRows = findings
    .slice(0, 6)
    .map((finding, index) => {
      const attribution = route.attribution?.findings[index];
      const owner =
        attribution === undefined || attribution.owner === "unattributed"
          ? "—"
          : `${attribution.owner}${attribution.source ? `: ${escapeHtml(attribution.source)}` : ""}${
              attribution.packageName ? ` (${escapeHtml(attribution.packageName)})` : ""
            }`;
      return (
        `<tr><td>${finding.kind}</td><td>${escapeHtml(finding.nodeType)}</td>` +
        `<td>${escapeHtml(finding.name)}</td><td>${(finding.retainedBytes / MB).toFixed(2)} MB</td>` +
        `<td>${owner}</td></tr>`
      );
    })
    .join("");
  return (
    `<section><h2><span class="badge" style="background:${color}">${verdict}</span> ` +
    `<code>${escapeHtml(route.route)}</code></h2>` +
    heapCurveSvg(route.samples, color) +
    `<p class="curve">heap ${curve} MB · ${(route.growthPer1000Requests / MB).toFixed(2)} MB/1000 req</p>` +
    withdrawn +
    warnings +
    (findingRows === ""
      ? ""
      : `<table><tr><th>kind</th><th>type</th><th>node</th><th>retained</th><th>owner</th></tr>${findingRows}</table>`) +
    `</section>`
  );
}

/** Self-contained report page: renders offline, from file://, no requests. */
export function renderHtmlReport(run: RunReport): string {
  const measured = run.routes.filter((route) => route.status === "measured");
  const skipped = run.routes.filter((route) => route.status === "skipped");
  const failed = run.routes.filter((route) => route.status === "failed");
  const environment = run.environment;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>next-leak — ${escapeHtml(run.appDir)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#222}
h1{font-size:1.3rem} h2{font-size:1rem;margin:1.5rem 0 .3rem}
.badge{color:#fff;border-radius:4px;padding:1px 8px;font-size:.8rem}
table{border-collapse:collapse;font-size:.85rem;margin:.5rem 0}
td,th{border:1px solid #ddd;padding:2px 8px;text-align:left}
.curve,.meta{color:#555;font-size:.85rem} .axis{font-size:9px;fill:#888}
.warn{color:#8a5a00;background:#fff8e6;border-left:3px solid #e67e22;padding:.4rem .7rem;font-size:.85rem}
code{background:#f4f4f4;padding:0 4px;border-radius:3px}
</style></head><body>
<h1>next-leak report</h1>
<p class="meta">${escapeHtml(run.appDir)} · ${escapeHtml(run.startedAt)} · node ${escapeHtml(
    environment.nodeVersion
  )} · ${escapeHtml(environment.platform)}/${escapeHtml(environment.arch)} · next ${escapeHtml(
    environment.nextVersion ?? "unknown"
  )} · next-leak ${escapeHtml(environment.nextLeakVersion)}</p>
${measured.map(measuredSection).join("\n")}
${
  skipped.length === 0
    ? ""
    : `<h2>Skipped</h2><ul>${skipped
        .map((route) => `<li><code>${escapeHtml(route.route)}</code> — ${escapeHtml(route.status === "skipped" ? route.reason : "")}</li>`)
        .join("")}</ul>`
}
${
  failed.length === 0
    ? ""
    : `<h2>Failed</h2><ul>${failed
        .map((route) => `<li><code>${escapeHtml(route.route)}</code> — ${escapeHtml(route.status === "failed" ? route.reason : "")}</li>`)
        .join("")}</ul>`
}
<p class="meta">Raw snapshots and run.json live next to this file — verify in Chrome DevTools → Memory → Load.</p>
</body></html>`;
}
