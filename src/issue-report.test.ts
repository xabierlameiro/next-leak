import { describe, expect, it } from "vitest";
import { renderIssueMarkdown } from "./issue-report.js";
import type { MeasuredRoute } from "./runner.js";
import { makeRunReport } from "./run-report.fixture.js";

function leakyRoute(): MeasuredRoute {
  const route = makeRunReport().routes.find(
    (candidate) => candidate.route === "/leaky" && candidate.status === "measured"
  );
  if (route?.status !== "measured") {
    throw new Error("fixture broken");
  }
  return route;
}

describe("renderIssueMarkdown", () => {
  it("follows the Next.js bug-template section order with full evidence", () => {
    const markdown = renderIssueMarkdown(leakyRoute(), makeRunReport());
    const sections = [
      "### Provide environment information",
      "### To Reproduce",
      "### Current vs. Expected behavior",
      "### Heap evidence",
      "### Verify it yourself",
    ];
    let cursor = -1;
    for (const section of sections) {
      const position = markdown.indexOf(section);
      expect(position, section).toBeGreaterThan(cursor);
      cursor = position;
    }
    expect(markdown).toContain("Next.js: 16.0.1");
    expect(markdown).toContain("npx next-leak <app-dir>");
    expect(markdown).toContain("warm-up 200 requests");
    expect(markdown).toContain("3 × [5000 requests at 100 connections → 30s idle");
    expect(markdown).toContain("29.1 → 30.5 → 33.6 → 35.9 MB");
    expect(markdown).toContain("0.54 MB per 1000 requests");
    expect(markdown).toContain("system / Context#object[.d]");
    expect(markdown).toContain("(historical) fetch retention");
    expect(markdown).toContain("baseline.heapsnapshot");
  });

  it("warns and blocks upstream filing when the leak is app-owned", () => {
    const markdown = renderIssueMarkdown(leakyRoute(), makeRunReport());
    expect(markdown).toContain("> [!WARNING]");
    expect(markdown).toContain("**your own code** (`src/app/leaky/page.tsx`)");
    expect(markdown).toContain("do **not** file this against Next.js");
  });

  it("reads as an upstream draft when the leak is framework-owned", () => {
    const route = leakyRoute();
    route.attribution = {
      findings: [{ owner: "framework", source: null, packageName: "next" }],
      route: { owner: "framework", source: null, packageName: "next", dominance: 1 },
    };
    const markdown = renderIssueMarkdown(route, makeRunReport());
    expect(markdown).not.toContain("> [!WARNING]");
    expect(markdown.startsWith("# Memory leak on route `/leaky`")).toBe(true);
  });
});

// The ISSUE draft is the artifact a Next.js maintainer reads. Weak assertions
// here (most of this file's mutants survived) would let a malformed public
// report ship unnoticed.
describe("renderIssueMarkdown fidelity", () => {
  it("states the exact measured curve, deltas and rate", () => {
    const markdown = renderIssueMarkdown(leakyRoute(), makeRunReport());
    expect(markdown).toContain("29.1 → 30.5 → 33.6 → 35.9 MB");
    expect(markdown).toContain("(per-cycle deltas +3.10, +2.30 MB)");
    expect(markdown).toContain("**0.54 MB per 1000 requests**");
  });

  it("echoes the actual ritual parameters used, not the defaults", () => {
    const report = makeRunReport();
    report.parameters = {
      warmupRequests: 50,
      loadRequests: 300,
      connections: 10,
      cycles: 5,
      idleMs: 7000,
    };
    const markdown = renderIssueMarkdown(leakyRoute(), report);
    expect(markdown).toContain("warm-up 50 requests");
    expect(markdown).toContain("5 × [300 requests at 10 connections → 7s idle");
  });

  it("reports the environment verbatim", () => {
    const markdown = renderIssueMarkdown(leakyRoute(), makeRunReport());
    expect(markdown).toContain("Node.js: v24.15.0");
    expect(markdown).toContain("OS: linux arm64 (Apple M3)");
    expect(markdown).toContain("Memory: 32 GB");
    expect(markdown).toContain("next-leak: 0.0.0");
  });

  it("lists findings with size, owner and retainer chain", () => {
    const markdown = renderIssueMarkdown(leakyRoute(), makeRunReport());
    expect(markdown).toContain("**grown** `[object] Array` 1.65 MB retained (app — `src/app/leaky/page.tsx`)");
    expect(markdown).toContain("retainers: `system / Context#object[.d] <- e#closure[.context]`");
  });

  it("names the requested path when it differs from the route template", () => {
    const route = leakyRoute();
    route.route = "/products/[id]";
    route.requestPath = "/products/42";
    const markdown = renderIssueMarkdown(route, makeRunReport());
    expect(markdown).toContain("# Memory leak on route `/products/[id]`");
    expect(markdown).toContain("against `/products/42`");
  });

  it("says so explicitly when there are no findings above thresholds", () => {
    const route = leakyRoute();
    route.diff = { typeDeltas: [], grownNodes: [], newNodes: [] };
    expect(renderIssueMarkdown(route, makeRunReport())).toContain("(no findings above thresholds)");
  });

  it("names the dependency, not a file, when a package owns the leak", () => {
    const route = leakyRoute();
    route.attribution = {
      findings: [{ owner: "dependency", source: null, packageName: "heavy-lib" }],
      route: { owner: "dependency", source: null, packageName: "heavy-lib", dominance: 1 },
    };
    const markdown = renderIssueMarkdown(route, makeRunReport());
    expect(markdown).toContain("the dependency **heavy-lib**");
    expect(markdown).toContain("do **not** file this against Next.js");
  });
});

describe("renderIssueMarkdown fallbacks", () => {
  it("marks unresolved findings as unattributed", () => {
    const route = leakyRoute();
    route.attribution = null;
    const markdown = renderIssueMarkdown(route, makeRunReport());
    expect(markdown).toContain("(unattributed)");
    expect(markdown).not.toContain("> [!WARNING]");
  });

  it("says (none) when a finding has no retainer chain", () => {
    const route = leakyRoute();
    if (route.diff === null) throw new Error("fixture broken");
    const first = route.diff.grownNodes[0];
    if (first === undefined) throw new Error("fixture broken");
    route.diff.grownNodes = [{ ...first, retainerChain: "" }];
    expect(renderIssueMarkdown(route, makeRunReport())).toContain("retainers: `(none)`");
  });

  it("omits the known-cause block when no signature matched", () => {
    const route = leakyRoute();
    route.signatures = [];
    expect(renderIssueMarkdown(route, makeRunReport())).not.toContain("Matched known causes");
  });

  it("does not label a non-historical signature as historical", () => {
    const route = leakyRoute();
    route.signatures = [
      { id: "x", title: "live issue", cause: "c", issue: "https://github.com/vercel/next.js/issues/2", historical: false },
    ];
    const markdown = renderIssueMarkdown(route, makeRunReport());
    expect(markdown).toContain("- live issue");
    expect(markdown).not.toContain("(historical) live issue");
  });

  it("names the snapshot files and work directory for verification", () => {
    const markdown = renderIssueMarkdown(leakyRoute(), makeRunReport());
    expect(markdown).toContain("`baseline.heapsnapshot` / `after.heapsnapshot`");
    expect(markdown).toContain("/apps/shop/.next-leak/2026-07-20T12-00-00-000Z");
  });
});

describe("renderIssueMarkdown without a diff", () => {
  it("reports no findings rather than inventing rows", () => {
    const route = leakyRoute();
    route.diff = null;
    const markdown = renderIssueMarkdown(route, makeRunReport());
    expect(markdown).toContain("(no findings above thresholds)");
    expect(markdown).not.toContain("Stryker");
  });
});

// This file gets pasted into someone else's tracker. What the run could not
// establish travels with it, or the first reviewer who notices discounts
// everything else in the report.
describe("renderIssueMarkdown measurement caveats", () => {
  const withWarnings = (warnings: Array<{ code: string; detail: string }>) => {
    const run = makeRunReport();
    const leaky = run.routes[1];
    if (leaky?.status !== "measured") throw new Error("fixture broken");
    leaky.confidence = { level: "low", warnings } as never;
    return renderIssueMarkdown(leaky, run);
  };

  it("omits the section entirely when the run was clean", () => {
    const run = makeRunReport();
    const leaky = run.routes[1];
    if (leaky?.status !== "measured") throw new Error("fixture broken");
    expect(renderIssueMarkdown(leaky, run)).not.toContain("Measurement caveats");
  });

  it("lists each caveat above the verification section", () => {
    const markdown = withWarnings([
      { code: "unsettled", detail: "the heap never held steady on cycle 2" },
    ]);
    expect(markdown).toContain("### Measurement caveats");
    expect(markdown).toContain("- the heap never held steady on cycle 2");
    expect(markdown.indexOf("Measurement caveats")).toBeLessThan(
      markdown.indexOf("### Verify it yourself")
    );
  });
});
