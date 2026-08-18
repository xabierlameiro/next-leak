import { describe, expect, it } from "vitest";
import { formatReport } from "./report.js";
import { makeRunReport } from "./run-report.fixture.js";

const MB = 1024 * 1024;

describe("formatReport", () => {
  it("renders verdicts, curves, findings, and non-measured routes", () => {
    const output = formatReport(makeRunReport());
    expect(output).toContain("next-leak — /apps/shop");
    expect(output).toContain(
      "✔ /  stable  (+0.06 MB/1000 req)  heap 29.4 MB → 31.5 MB → 32.3 MB → 32.1 MB"
    );
    expect(output).toContain("✖ /leaky  leak  (+0.54 MB/1000 req)");
    expect(output).toContain("culprit: src/app/leaky/page.tsx (your code)");
    expect(output).toContain(
      "↳ grown [object] Array 1.6 MB — src/app/leaky/page.tsx (your code)"
    );
    expect(output).toContain(
      "⚠ known cause (historical): fetch retention — https://github.com/vercel/next.js/issues/90433"
    );
    expect(output).toContain("– /products/[id]  skipped: needs sample params");
    expect(output).toContain("✖ /broken  failed: route exploded under load");
    expect(output).toContain("snapshots and run.json: /apps/shop/.next-leak/");
  });

  it("points at the generated bundle in the footer", () => {
    const output = formatReport(makeRunReport());
    expect(output).toContain("report: /apps/shop/.next-leak/2026-07-20T12-00-00-000Z/report.html");
    expect(output).toContain(
      "issue draft (/leaky): /apps/shop/.next-leak/2026-07-20T12-00-00-000Z/ISSUE-leaky.md"
    );
  });

  it("prints the exact re-run command for inconclusive routes", () => {
    const report = makeRunReport();
    const healthy = report.routes[0];
    if (healthy?.status !== "measured") {
      throw new Error("fixture broken");
    }
    healthy.trend = { ...healthy.trend, verdict: "inconclusive" };
    const output = formatReport(report);
    expect(output).toContain("inconclusive means sustained sub-threshold growth");
    expect(output).toContain("next-leak /apps/shop --routes / --cycles 8");
  });

  it("says which cycle count a resolved verdict was judged over", () => {
    const report = makeRunReport();
    const healthy = report.routes[0];
    if (healthy?.status !== "measured") throw new Error("fixture broken");
    healthy.resolvedWithCycles = 8;
    const output = formatReport(report);
    expect(output).toContain("(resolved at 8 cycles)");
    // The footer quotes the run's figure and the resolved one, not just the
    // parameter the user passed.
    expect(output).toContain("judged over 4 cycles (8 where resolved)");
  });

  it("prints no hint when nothing is inconclusive", () => {
    expect(formatReport(makeRunReport())).not.toContain("hint:");
  });

  // A reader cannot tell a real `stable` from a run that was simply not
  // sensitive enough unless the gate is on the page next to the verdict.
  it("states the regime every verdict was judged under", () => {
    const output = formatReport(makeRunReport());
    expect(output).toContain("judged over 4 cycles × 5000 requests");
    expect(output).toContain("growth gate 256 KiB/cycle");
    expect(output).toContain("+0.05 MB/1000 req");
    expect(output).toContain("heap cap 512 MB");
  });

  it("reports peak pressure beside a stable verdict without contradicting it", () => {
    // The vercel/next.js#92287 shape: reclaimed after GC, lethal under load.
    const report = makeRunReport();
    report.parameters = { ...report.parameters, maxOldSpaceMb: 6144 };
    const healthy = report.routes[0];
    if (healthy?.status !== "measured") {
      throw new Error("fixture broken");
    }
    healthy.peaks = [
      {
        phase: "cycle 1",
        heapUsed: 3100 * MB,
        external: 3600 * MB,
        arrayBuffers: 3500 * MB,
        rss: 3800 * MB,
        polls: 60,
      },
    ];
    const output = formatReport(report);
    expect(output).toContain("stable");
    expect(output).toContain("peak pressure");
    expect(output).toContain("3800.0 MB");
  });

  it("says nothing about peaks on a proportionate route", () => {
    expect(formatReport(makeRunReport())).not.toContain("peak pressure");
  });

  it("reports unreclaimed retention beside a stable verdict", () => {
    // The vercel/next.js#96533 shape, measured 2026-08-18: arrayBuffers held
    // between collections against a flat 0.32 MB after one. The pre-collection
    // series does not climb — the gap is the finding.
    const report = makeRunReport();
    const healthy = report.routes[0];
    if (healthy?.status !== "measured") {
      throw new Error("fixture broken");
    }
    const held = [4.11, 0.32, 5.03, 4.44, 3.35, 5.72];
    healthy.unreclaimedSamples = held.map((mb) => ({
      gcExposed: true,
      heapUsed: 40 * MB,
      rss: 190 * MB,
      external: mb * MB,
      arrayBuffers: mb * MB,
    }));
    healthy.memorySamples = healthy.memorySamples.map((sample) => ({
      ...sample,
      external: 0.32 * MB,
      arrayBuffers: 0.32 * MB,
    }));
    const output = formatReport(report);

    expect(output).toContain("stable");
    expect(output).toContain("unreclaimed");
    expect(output).toContain("arrayBuffers");
    expect(output).toContain("what it retains");
  });

  it("says nothing about unreclaimed memory on a route that is flat both ways", () => {
    expect(formatReport(makeRunReport())).not.toContain("unreclaimed");
  });
});

// Renderer regressions: the mutation run showed the report bodies were only
// weakly asserted, so wrong numbers or dropped rows could ship unnoticed.
describe("formatReport numeric fidelity", () => {
  it("prints growth per 1000 requests with sign and two decimals", () => {
    const report = makeRunReport();
    const leaky = report.routes[1];
    if (leaky?.status !== "measured") throw new Error("fixture broken");
    leaky.growthPer1000Requests = -1.5 * 1024 * 1024;
    expect(formatReport(report)).toContain("(-1.50 MB/1000 req)");
  });

  it("lists at most three findings per route", () => {
    const report = makeRunReport();
    const leaky = report.routes[1];
    if (leaky?.status !== "measured" || leaky.diff === null) throw new Error("fixture broken");
    const base = leaky.diff.grownNodes[0];
    if (base === undefined) throw new Error("fixture broken");
    leaky.diff.grownNodes = [base, { ...base, name: "B" }, { ...base, name: "C" }, { ...base, name: "D" }];
    const output = formatReport(report);
    expect(output).toContain("↳ grown [object] Array");
    expect(output).not.toContain("] D ");
  });

  it("renders every non-measured route exactly once", () => {
    const output = formatReport(makeRunReport());
    expect(output.split("\n").filter((line) => line.includes("/products/[id]"))).toHaveLength(1);
    expect(output.split("\n").filter((line) => line.includes("/broken"))).toHaveLength(1);
  });
});

// Owner labels are the sentence a user acts on; each branch is asserted.
describe("formatReport owner labels", () => {
  const withOwner = (owner: string, source: string | null, packageName: string | null) => {
    const report = makeRunReport();
    const leaky = report.routes[1];
    if (leaky?.status !== "measured") throw new Error("fixture broken");
    const attribution = { owner, source, packageName } as never;
    leaky.attribution = { findings: [attribution], route: { ...(attribution as object), dominance: 1 } as never };
    return formatReport(report);
  };

  it("names the file for app-owned leaks", () => {
    expect(withOwner("app", "src/app/x.tsx", null)).toContain("culprit: src/app/x.tsx (your code)");
  });

  it("names the package for dependency-owned leaks", () => {
    expect(withOwner("dependency", null, "heavy-lib")).toContain("culprit: heavy-lib (dependency)");
  });

  it("says framework internals when no package resolves", () => {
    expect(withOwner("framework", null, null)).toContain("culprit: Next.js/runtime internals");
    expect(withOwner("framework", null, "next")).toContain("culprit: next (framework)");
  });

  it("prints no culprit line when nothing is attributed", () => {
    expect(withOwner("unattributed", null, null)).not.toContain("culprit:");
  });

  it("falls back to generic wording when the source is missing", () => {
    expect(withOwner("app", null, null)).toContain("your code (your code)");
    expect(withOwner("dependency", null, null)).toContain("a dependency (dependency)");
  });
});

describe("formatReport numeric edge cases", () => {
  it("prints a plus sign for exactly zero growth", () => {
    const report = makeRunReport();
    const healthy = report.routes[0];
    if (healthy?.status !== "measured") throw new Error("fixture broken");
    healthy.growthPer1000Requests = 0;
    expect(formatReport(report)).toContain("(+0.00 MB/1000 req)");
  });

  it("doubles the cycle count in the re-run hint, never halves it", () => {
    const report = makeRunReport();
    report.parameters = { ...report.parameters, cycles: 6 };
    const healthy = report.routes[0];
    if (healthy?.status !== "measured") throw new Error("fixture broken");
    healthy.trend = { ...healthy.trend, verdict: "inconclusive" };
    expect(formatReport(report)).toContain("--cycles 12");
  });

  it("never suggests fewer than six cycles", () => {
    const report = makeRunReport();
    // The 3-cycle minimum is the only run whose doubling reaches the floor.
    report.parameters = { ...report.parameters, cycles: 3 };
    const healthy = report.routes[0];
    if (healthy?.status !== "measured") throw new Error("fixture broken");
    healthy.trend = { ...healthy.trend, verdict: "inconclusive" };
    expect(formatReport(report)).toContain("--cycles 6");
  });
});

// Found while measuring a real GitHub issue (#84648): the reporter observed
// ~15 GB of *process* memory, but the tool only surfaced the JS heap, hiding
// the very distinction it promises to make.
describe("formatReport RSS awareness", () => {
  const withRss = (rssValues: number[], rssPer1000: number) => {
    const report = makeRunReport();
    const healthy = report.routes[0];
    if (healthy?.status !== "measured") throw new Error("fixture broken");
    healthy.memorySamples = rssValues.map((rss) => ({
      gcExposed: true,
      heapUsed: 30 * 1024 * 1024,
      rss,
      external: 0,
      arrayBuffers: 0,
    }));
    healthy.rssPer1000Requests = rssPer1000;
    return formatReport(report);
  };
  const MBs = 1024 * 1024;

  it("flags a flat heap with climbing RSS as a non-heap problem", () => {
    const output = withRss([100 * MBs, 400 * MBs, 900 * MBs, 1500 * MBs], 20 * MBs);
    expect(output).toContain("heap is flat but RSS grows");
    expect(output).toContain("not a JS-heap leak");
    expect(output).toContain("RSS 100.0 MB → 400.0 MB → 900.0 MB → 1500.0 MB");
  });

  it("stays quiet when RSS is stable too", () => {
    expect(withRss([100 * MBs, 101 * MBs, 100 * MBs, 101 * MBs], 0.001 * MBs)).not.toContain(
      "RSS grows"
    );
  });

  // Regression from a real run: short runs made the per-1000-request rate
  // explode on a few MB of ordinary jitter, firing the note on a healthy route.
  it("does not fire on small RSS jitter during short runs", () => {
    const output = withRss([117.5 * MBs, 119.4 * MBs, 120.5 * MBs, 122.5 * MBs], 7.89 * MBs);
    expect(output).not.toContain("RSS grows");
  });

  it("requires sustained growth, not one big jump", () => {
    const output = withRss([100 * MBs, 900 * MBs, 905 * MBs, 902 * MBs], 30 * MBs);
    expect(output).not.toContain("RSS grows");
  });
});

// The instrument's opinion of its own reading. A verdict rendered without it
// is exactly the failure mode this audit exists to prevent.
describe("formatReport confidence", () => {
  const withConfidence = (confidence: unknown) => {
    const report = makeRunReport();
    const leaky = report.routes[1];
    if (leaky?.status !== "measured") throw new Error("fixture broken");
    leaky.confidence = confidence as never;
    return formatReport(report);
  };

  it("says nothing when the measurement supports its verdict", () => {
    expect(formatReport(makeRunReport())).not.toContain("low confidence");
  });

  it("prints every warning the audit raised", () => {
    const output = withConfidence({
      level: "low",
      warnings: [
        { code: "unsettled", detail: "the heap never held steady on cycle 2" },
        { code: "load-incomplete", detail: "cycle 1 landed 400 of 5000 requests" },
      ],
    });
    expect(output).toContain("⚠ low confidence: the heap never held steady on cycle 2");
    expect(output).toContain("⚠ low confidence: cycle 1 landed 400 of 5000 requests");
  });

  it("shows the withdrawn verdict, not the measured one", () => {
    const output = withConfidence({
      level: "low",
      warnings: [{ code: "unsettled", detail: "never settled" }],
      supersededVerdict: "inconclusive",
    });
    // The headline must carry the verdict the evidence supports…
    expect(output).toContain("? /leaky  inconclusive");
    expect(output).not.toContain("✖ /leaky  leak");
    // …while still disclosing what was measured.
    expect(output).toContain("measured leak, withdrawn");
  });

  it("routes a withdrawn verdict into the inconclusive re-run hint", () => {
    const output = withConfidence({
      level: "low",
      warnings: [{ code: "unsettled", detail: "never settled" }],
      supersededVerdict: "inconclusive",
    });
    expect(output).toContain("--routes /leaky");
  });
});

// An ISR route serves its cache unless the request carries the build's own
// revalidation header. Measured on vercel/next.js#96533: the same app reports
// `leak` with that header and `stable` without it — so a route the run could
// not drive must never be presented as healthy.
describe("formatReport for routes that were not exercised", () => {
  it("says not exercised, never stable", () => {
    const report = makeRunReport();
    report.routes = [
      {
        route: "/posts/[slug]",
        status: "not-exercised",
        reason:
          "revalidates every 3600s, but the build's prerender-manifest.json carries no previewModeId",
      },
    ];
    const output = formatReport(report);

    expect(output).toContain("/posts/[slug]  not exercised:");
    expect(output).toContain("3600s");
    expect(output).not.toContain("stable");
  });
});

describe("formatReport for ISR routes driven through revalidation", () => {
  it("says the route was driven, and how often it revalidates", () => {
    // Without this line a reader cannot tell a curve measured against a
    // re-render from one measured against a static cache.
    const report = makeRunReport();
    const route = report.routes[0];
    if (route?.status !== "measured") throw new Error("fixture broken");
    route.revalidatedEverySeconds = 3600;
    const output = formatReport(report);

    expect(output).toContain("driven through ISR revalidation");
    expect(output).toContain("revalidates every 3600s");
  });

  it("says nothing for a route that is not ISR", () => {
    expect(formatReport(makeRunReport())).not.toContain("ISR revalidation");
  });
});
