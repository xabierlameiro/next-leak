import { describe, expect, it } from "vitest";
import { formatBuildReport } from "./build-report.js";
import type { BuildRunResult } from "./build-run.js";
import { formatReport } from "./report.js";
import { makeRunReport } from "./run-report.fixture.js";
import { terminalSafe } from "./terminal-text.js";

const ESC = "\u001b";
const BEL = "\u0007";

describe("terminalSafe", () => {
  it("leaves plain text, line breaks and tabs alone", () => {
    expect(terminalSafe("✔ /leaky  leak\n\tnext line — é")).toBe("✔ /leaky  leak\n\tnext line — é");
  });

  it("removes a complete escape sequence and keeps the text around it", () => {
    expect(terminalSafe(`before${ESC}[2K${ESC}[1Aafter`)).toBe("beforeafter");
    expect(terminalSafe(`${ESC}[31mred${ESC}[39m`)).toBe("red");
    // The same opener in its one-byte form.
    expect(terminalSafe("before\u009b2Kafter")).toBe("beforeafter");
  });

  it("shows a control character that is not part of a sequence", () => {
    expect(terminalSafe(`a${ESC}b`)).toBe("a\\x1bb");
    expect(terminalSafe(`ring${BEL}`)).toBe("ring\\x07");
    expect(terminalSafe("back\bspace")).toBe("back\\x08space");
    expect(terminalSafe("del\u007f")).toBe("del\\x7f");
    expect(terminalSafe("c1\u0085")).toBe("c1\\x85");
  });

  it("shows a carriage return, which would let a line overwrite itself", () => {
    expect(terminalSafe("✖ leak\r✔ stable")).toBe("✖ leak\\x0d✔ stable");
  });

  it("reads a Windows line ending as a line ending", () => {
    expect(terminalSafe("one\r\ntwo")).toBe("one\ntwo");
  });
});

describe("what the reports write to the terminal", () => {
  it("does not pass a heap name's control characters through", () => {
    const report = makeRunReport();
    const leaky = report.routes.find((route) => route.route === "/leaky");
    if (leaky?.status !== "measured" || leaky.diff === null) throw new Error("fixture broken");
    const finding = leaky.diff.grownNodes[0];
    if (finding === undefined) throw new Error("fixture broken");
    finding.name = `payload${ESC}[2J${ESC}[H\r✔ /leaky  stable${BEL}`;

    const output = formatReport(report);

    expect(output).not.toContain(ESC);
    expect(output).not.toContain(BEL);
    expect(output).not.toContain("\r");
    expect(output).toContain("payload\\x0d✔ /leaky  stable\\x07");
  });

  it("does not pass the build's own output through either", () => {
    const failed: BuildRunResult = {
      appDir: "/apps/docs",
      status: "build-failed",
      samplingFailure: null,
      verdict: null,
      trend: null,
      levels: [],
      workers: [],
      parentSamples: [],
      peakWorkerRssBytes: 0,
      netGrowthBytes: 0,
      pagesGenerated: null,
      retentionPerPageBytes: null,
      heapExhausted: false,
      capture: null,
      captureRequested: false,
      captureFailure: null,
      strippedCapWarning: null,
      exitCode: 1,
      output: `${ESC}[31mType error${ESC}[39m: nope\r\n${ESC}]0;owned${BEL}done`,
    };

    const output = formatBuildReport(failed);

    expect(output).not.toContain(ESC);
    expect(output).not.toContain(BEL);
    expect(output).toContain("      Type error: nope\n      done");
  });
});
