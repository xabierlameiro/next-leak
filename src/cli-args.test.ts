import { describe, expect, it } from "vitest";
import { helpText, parseCliArgs } from "./cli-args.js";

describe("parseCliArgs", () => {
  it("parses a bare app dir with defaults", () => {
    const parsed = parseCliArgs(["./my-app"]);
    expect(parsed).toEqual({
      kind: "run",
      options: {
        appDir: "./my-app",
        routes: null,
        cycles: null,
        requests: null,
        connections: null,
        idleSeconds: null,
        quick: false,
        diffAll: false,
        output: null,
      },
    });
  });

  it("parses every flag", () => {
    const parsed = parseCliArgs([
      "app", "--routes", "/api,/dashboard", "--cycles", "6", "--requests", "1000",
      "--connections", "20", "--idle", "8", "--quick", "--diff-all", "--output", "/tmp/out",
    ]);
    if (parsed.kind !== "run") {
      throw new Error(`expected run, got ${parsed.kind}`);
    }
    expect(parsed.options).toEqual({
      appDir: "app",
      routes: ["/api", "/dashboard"],
      cycles: 6,
      requests: 1000,
      connections: 20,
      idleSeconds: 8,
      quick: true,
      diffAll: true,
      output: "/tmp/out",
    });
  });

  it("rejects unknown flags naming them (typos never fall back to defaults)", () => {
    const parsed = parseCliArgs(["app", "--cicles", "6"]);
    expect(parsed).toEqual({ kind: "error", message: 'unknown option "--cicles" — see --help' });
  });

  it("rejects non-numeric and missing values", () => {
    expect(parseCliArgs(["app", "--cycles", "many"]).kind).toBe("error");
    expect(parseCliArgs(["app", "--requests"]).kind).toBe("error");
    expect(parseCliArgs(["app", "--output", "--cycles"]).kind).toBe("error");
  });

  it("enforces the 3-cycle minimum the verdict needs", () => {
    const parsed = parseCliArgs(["app", "--cycles", "2"]);
    expect(parsed.kind).toBe("error");
    if (parsed.kind === "error") {
      expect(parsed.message).toContain("at least 3 cycles");
    }
  });

  it("routes -h/-v and bare invocation", () => {
    expect(parseCliArgs(["-h"]).kind).toBe("help");
    expect(parseCliArgs(["app", "--version"]).kind).toBe("version");
    expect(parseCliArgs([]).kind).toBe("help");
    expect(parseCliArgs(["a", "b"]).kind).toBe("error");
  });
});

describe("helpText", () => {
  it("documents every flag with its default", () => {
    const help = helpText("1.2.3");
    expect(help).toContain("next-leak 1.2.3");
    for (const flag of ["--routes", "--cycles", "--requests", "--connections", "--idle", "--diff-all", "--output", "--help", "--version"]) {
      expect(help).toContain(flag);
    }
    expect(help).toContain("default 3");
    expect(help).toContain("default 5000");
    expect(help).toContain("default 100");
    expect(help).toContain("default 30");
  });
});

describe("parseCliArgs guardrails", () => {
  it("rejects an empty route selector instead of silently measuring everything", () => {
    const parsed = parseCliArgs(["app", "--routes", ",,,"]);
    expect(parsed.kind).toBe("error");
    if (parsed.kind === "error") {
      expect(parsed.message).toContain("at least one route");
    }
  });

  it("reports negative numbers as bad values, not missing ones", () => {
    const parsed = parseCliArgs(["app", "--requests", "-5"]);
    expect(parsed.kind).toBe("error");
    if (parsed.kind === "error") {
      expect(parsed.message).toContain("positive integer");
    }
  });

  it("caps absurd values that would start an endless run", () => {
    for (const [flag, value] of [["--requests", "999999999999"], ["--cycles", "5000"], ["--connections", "99999"], ["--idle", "999999"]]) {
      const parsed = parseCliArgs(["app", flag ?? "", value ?? ""]);
      expect(parsed.kind, `${flag} ${value}`).toBe("error");
    }
  });
});

// Closing the surviving mutants: every line below is text a user reads, or a
// boundary where a silent off-by-one changes what runs.
describe("parseCliArgs message and boundary precision", () => {
  const errorMessage = (args: string[]): string => {
    const parsed = parseCliArgs(args);
    if (parsed.kind !== "error") {
      throw new Error(`expected an error for ${args.join(" ")}`);
    }
    return parsed.message;
  };

  it("distinguishes negative numbers from missing values and from flags", () => {
    expect(errorMessage(["app", "--requests", "-5"])).toContain("positive integer");
    expect(errorMessage(["app", "--requests", "-5.5"])).toContain("positive integer");
    // A real flag after an option is a missing value, not a bad one.
    expect(errorMessage(["app", "--requests", "--cycles"])).toContain("needs a value <n>");
    expect(errorMessage(["app", "--output", "-x"])).toContain("needs a value <dir>");
  });

  it("accepts values exactly at the cap and rejects one past it", () => {
    const run = (flag: string, value: string) => parseCliArgs(["app", flag, value]).kind;
    expect(run("--requests", "1000000")).toBe("run");
    expect(run("--requests", "1000001")).toBe("error");
    expect(run("--cycles", "100")).toBe("run");
    expect(run("--cycles", "101")).toBe("error");
    expect(run("--connections", "10000")).toBe("run");
    expect(run("--connections", "10001")).toBe("error");
    expect(run("--idle", "3600")).toBe("run");
    expect(run("--idle", "3601")).toBe("error");
  });

  it("names the cap and the offending value in the message", () => {
    expect(errorMessage(["app", "--cycles", "5000"])).toContain("capped at 100");
    expect(errorMessage(["app", "--cycles", "5000"])).toContain("got 5000");
  });

  it("accepts exactly 3 cycles and rejects 2 with the verdict rationale", () => {
    expect(parseCliArgs(["app", "--cycles", "3"]).kind).toBe("run");
    expect(errorMessage(["app", "--cycles", "2"])).toContain("at least 3 cycles");
  });

  it("honours --help and --version wherever they appear", () => {
    expect(parseCliArgs(["app", "--routes", "/x", "--help"]).kind).toBe("help");
    expect(parseCliArgs(["--help", "app"]).kind).toBe("help");
    expect(parseCliArgs(["app", "--cycles", "5", "-v"]).kind).toBe("version");
  });

  it("rejects fractional and non-numeric values", () => {
    expect(errorMessage(["app", "--cycles", "3.5"])).toContain("positive integer");
    expect(errorMessage(["app", "--idle", "abc"])).toContain('got "abc"');
  });
});

describe("helpText formatting", () => {
  const help = helpText("9.9.9");

  it("renders aliases, argument names and descriptions on one line each", () => {
    expect(help).toContain("  --routes <list>           Only measure these routes");
    expect(help).toContain("  -h, --help                Show this help");
    expect(help).toContain("  -v, --version             Print the version");
    expect(help).toContain("  --diff-all                Diff snapshots for stable routes too (slow)");
  });

  it("documents usage, the ritual and exit codes", () => {
    expect(help).toContain("next-leak <app-dir> [options]");
    expect(help).toContain('output: "standalone"');
    expect(help).toContain("warm-up → GC → baseline snapshot");
    expect(help).toContain("130 when");
  });
});

describe("parseCliArgs value normalisation", () => {
  it("rejects zero as a value", () => {
    for (const flag of ["--requests", "--cycles", "--connections", "--idle"]) {
      expect(parseCliArgs(["app", flag, "0"]).kind, flag).toBe("error");
    }
  });

  it("trims whitespace around route selectors", () => {
    const parsed = parseCliArgs(["app", "--routes", " /api , /dashboard "]);
    if (parsed.kind !== "run") throw new Error("expected run");
    expect(parsed.options.routes).toEqual(["/api", "/dashboard"]);
  });

  it("treats a malformed negative-looking value as a missing value", () => {
    const parsed = parseCliArgs(["app", "--requests", "--5"]);
    expect(parsed.kind).toBe("error");
  });
});

// The fast preset exists because a default run on a 60-route app is hours,
// and hours is where first-time users give up.
describe("--quick", () => {
  it("parses the flag and defaults to off", () => {
    const on = parseCliArgs(["/app", "--quick"]);
    const off = parseCliArgs(["/app"]);
    if (on.kind !== "run" || off.kind !== "run") throw new Error("expected run");
    expect(on.options.quick).toBe(true);
    expect(off.options.quick).toBe(false);
  });

  it("coexists with explicit overrides, which win downstream", () => {
    const parsed = parseCliArgs(["/app", "--quick", "--cycles", "6"]);
    if (parsed.kind !== "run") throw new Error("expected run");
    expect(parsed.options.quick).toBe(true);
    expect(parsed.options.cycles).toBe(6);
  });

  it("documents itself in the help text", () => {
    expect(helpText("0.0.0")).toContain("--quick");
  });
});
