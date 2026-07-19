import { describe, expect, it } from "vitest";
import { renderHtmlReport } from "./html-report.js";
import { makeRunReport } from "./run-report.fixture.js";

describe("renderHtmlReport", () => {
  const html = renderHtmlReport(makeRunReport());

  it("renders one curve per measured route with verdict badges", () => {
    expect(html).toContain("<polyline");
    expect((html.match(/<svg /g) ?? []).length).toBe(2);
    expect(html).toContain(">leak</span>");
    expect(html).toContain(">stable</span>");
    expect(html).toContain("29.4 → 31.5 → 32.3 → 32.1 MB");
  });

  it("includes environment, findings ownership, and non-measured routes", () => {
    expect(html).toContain("node v24.15.0");
    expect(html).toContain("next 16.0.1");
    expect(html).toContain("app: src/app/leaky/page.tsx");
    expect(html).toContain("/products/[id]");
    expect(html).toContain("route exploded under load");
  });

  it("loads no external resources (offline-renderable)", () => {
    expect(html).not.toMatch(/<script[\s>]/);
    expect(html).not.toMatch(/<link[\s>]/);
    expect(html).not.toMatch(/src="http/);
    expect(html).not.toMatch(/url\(/);
  });

  it("escapes HTML in report-controlled strings", () => {
    const report = makeRunReport();
    report.routes.push({ route: "/<script>", status: "skipped", reason: "x<y" });
    const output = renderHtmlReport(report);
    expect(output).toContain("/&lt;script&gt;");
    expect(output).not.toContain("<script>");
  });
});

// The HTML report carried the most surviving mutants: wrong numbers or a
// dropped route would have shipped unnoticed.
describe("renderHtmlReport fidelity", () => {
  it("plots one point per sample and scales the axis to the data", () => {
    const html = renderHtmlReport(makeRunReport());
    const firstSvg = html.slice(html.indexOf("<svg "), html.indexOf("</svg>"));
    expect((firstSvg.match(/<circle /g) ?? []).length).toBe(4);
    expect(firstSvg).toContain("32.3 MB"); // max of the healthy route
    expect(firstSvg).toContain("29.4 MB"); // min of the healthy route
  });

  it("shows the growth rate and finding sizes with two decimals", () => {
    const html = renderHtmlReport(makeRunReport());
    expect(html).toContain("0.54 MB/1000 req");
    expect(html).toContain("1.65 MB");
  });

  it("renders a row per finding with its owner", () => {
    const html = renderHtmlReport(makeRunReport());
    expect(html).toContain("<td>grown</td>");
    expect(html).toContain("app: src/app/leaky/page.tsx");
  });

  it("keeps skipped and failed sections separate", () => {
    const html = renderHtmlReport(makeRunReport());
    expect(html.indexOf("<h2>Skipped</h2>")).toBeGreaterThan(0);
    expect(html.indexOf("<h2>Failed</h2>")).toBeGreaterThan(html.indexOf("<h2>Skipped</h2>"));
  });

  it("omits empty sections entirely", () => {
    const report = makeRunReport();
    report.routes = report.routes.filter((route) => route.status === "measured");
    const html = renderHtmlReport(report);
    expect(html).not.toContain("Skipped");
    expect(html).not.toContain("Failed");
  });

  it("survives a single-sample route without dividing by zero", () => {
    const report = makeRunReport();
    const healthy = report.routes[0];
    if (healthy?.status !== "measured") throw new Error("fixture broken");
    healthy.samples = [10 * 1024 * 1024];
    const html = renderHtmlReport(report);
    expect(html).toContain("<polyline");
    expect(html).not.toContain("NaN");
  });
});

// Closing the arithmetic and fallback survivors: wrong coordinates draw a
// wrong curve, and fallback labels are what a reader sees when attribution
// or findings are absent.
describe("renderHtmlReport exact geometry and fallbacks", () => {
  it("plots the polyline at the exact computed coordinates", () => {
    const html = renderHtmlReport(makeRunReport());
    const points = /points="([^"]+)"/.exec(html)?.[1];
    // 320×96 viewBox, 8px padding, y inverted and scaled to [min,max].
    expect(points).toBe("8.0,88.0 109.3,30.1 210.7,8.0 312.0,13.5");
  });

  it("labels the axis with the route's own max and min", () => {
    const html = renderHtmlReport(makeRunReport());
    const labels = html.match(/class="axis">([^<]+)</g) ?? [];
    expect(labels[0]).toContain("32.3 MB");
    expect(labels[1]).toContain("29.4 MB");
  });

  it("places a circle at every sample coordinate", () => {
    const html = renderHtmlReport(makeRunReport());
    expect(html).toContain('<circle cx="8.0" cy="88.0"');
    expect(html).toContain('<circle cx="312.0" cy="13.5"');
  });

  it("falls back to an em dash when a finding has no owner", () => {
    const report = makeRunReport();
    const leaky = report.routes[1];
    if (leaky?.status !== "measured") throw new Error("fixture broken");
    leaky.attribution = null;
    const html = renderHtmlReport(report);
    expect(html).toContain("<td>—</td>");
  });

  it("shows the package name for dependency-owned findings", () => {
    const report = makeRunReport();
    const leaky = report.routes[1];
    if (leaky?.status !== "measured") throw new Error("fixture broken");
    leaky.attribution = {
      findings: [{ owner: "dependency", source: null, packageName: "heavy-lib" }],
      route: { owner: "dependency", source: null, packageName: "heavy-lib", dominance: 1 },
    };
    expect(renderHtmlReport(report)).toContain("dependency (heavy-lib)");
  });

  it("renders measured routes only in the chart area", () => {
    const report = makeRunReport();
    report.routes = [{ route: "/x", status: "skipped", reason: "why" }];
    const html = renderHtmlReport(report);
    expect(html).not.toContain("<svg ");
    expect(html).toContain("why");
  });

  it("uses distinct verdict colours", () => {
    const html = renderHtmlReport(makeRunReport());
    expect(html).toContain("background:#27ae60"); // stable
    expect(html).toContain("background:#c0392b"); // leak
  });
});

describe("renderHtmlReport axis placement", () => {
  it("keeps the lower axis label inside the viewBox", () => {
    const html = renderHtmlReport(makeRunReport());
    // height is 96; the label sits at height-1 so it never clips outside.
    expect(html).toContain('y="95" class="axis"');
    expect(html).not.toContain('y="97"');
  });

  it("caps the findings table at six rows", () => {
    const report = makeRunReport();
    const leaky = report.routes[1];
    if (leaky?.status !== "measured" || leaky.diff === null) throw new Error("fixture broken");
    const base = leaky.diff.grownNodes[0];
    if (base === undefined) throw new Error("fixture broken");
    leaky.diff.grownNodes = Array.from({ length: 9 }, (_, index) => ({ ...base, name: `N${index}` }));
    const html = renderHtmlReport(report);
    expect((html.match(/<tr><td>grown<\/td>/g) ?? []).length).toBe(6);
    expect(html).not.toContain("N7");
  });
});

describe("renderHtmlReport confidence", () => {
  const withConfidence = (confidence: unknown) => {
    const run = makeRunReport();
    const leaky = run.routes[1];
    if (leaky?.status !== "measured") throw new Error("fixture broken");
    leaky.confidence = confidence as never;
    return renderHtmlReport(run);
  };

  it("shows no warning block for a clean measurement", () => {
    expect(renderHtmlReport(makeRunReport())).not.toContain('class="warn"');
  });

  it("renders each warning, escaping its text", () => {
    const html = withConfidence({
      level: "low",
      warnings: [{ code: "unsettled", detail: "heap moved on <cycle 2>" }],
    });
    expect(html).toContain('<li>heap moved on &lt;cycle 2&gt;</li>');
  });

  it("badges the withdrawn verdict and states what was measured", () => {
    const html = withConfidence({
      level: "low",
      warnings: [],
      supersededVerdict: "inconclusive",
    });
    expect(html).toContain(">inconclusive</span>");
    expect(html).toContain("Measured <strong>leak</strong>, withdrawn");
  });
});
