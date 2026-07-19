export type CliRunOptions = {
  appDir: string;
  routes: string[] | null;
  cycles: number | null;
  requests: number | null;
  connections: number | null;
  idleSeconds: number | null;
  quick: boolean;
  diffAll: boolean;
  output: string | null;
};

export type ParsedCli =
  | { kind: "run"; options: CliRunOptions }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

type FlagSpec = {
  flag: string;
  alias?: string;
  value: "none" | "string" | "int" | "list";
  argName?: string;
  help: string;
};

/** Single source of truth: parsing and --help both derive from this table. */
const FLAGS: FlagSpec[] = [
  {
    flag: "--routes",
    value: "list",
    argName: "<list>",
    help: "Only measure these routes — comma-separated templates or prefixes (e.g. /api,/dashboard)",
  },
  { flag: "--cycles", value: "int", argName: "<n>", help: "Load cycles per route (default 3, minimum 3)" },
  { flag: "--requests", value: "int", argName: "<n>", help: "Requests per cycle (default 5000)" },
  { flag: "--connections", value: "int", argName: "<n>", help: "Concurrent connections (default 100)" },
  { flag: "--idle", value: "int", argName: "<seconds>", help: "Idle seconds before each sample (default 30)" },
  {
    flag: "--quick",
    value: "none",
    help: "Fast preset: 2000 requests x 4 cycles, 8s idle — the profile used for real-app validation",
  },
  { flag: "--diff-all", value: "none", help: "Diff snapshots for stable routes too (slow)" },
  { flag: "--output", value: "string", argName: "<dir>", help: "Where to write runs (default <app-dir>/.next-leak)" },
  { flag: "--help", alias: "-h", value: "none", help: "Show this help" },
  { flag: "--version", alias: "-v", value: "none", help: "Print the version" },
];

export function helpText(version: string): string {
  const rows = FLAGS.map((spec) => {
    const left = `${spec.alias ? `${spec.alias}, ` : ""}${spec.flag}${spec.argName ? ` ${spec.argName}` : ""}`;
    return `  ${left.padEnd(26)}${spec.help}`;
  }).join("\n");
  return `next-leak ${version}

Find out whether your Next.js app actually leaks memory — how much, on which
route, and whose fault it is.

Usage:
  next-leak <app-dir> [options]

The app must be built with output: "standalone" (next build). For each
discovered route, next-leak boots a fresh instrumented process and runs:
warm-up → GC → baseline snapshot → [load → idle → GC → sample] × cycles →
snapshot. Evidence (report.html, ISSUE drafts, raw snapshots, run.json) is
written under the output directory.

Options:
${rows}

Exit codes: 0 when the run completes (whatever the verdicts), 130 when
interrupted, 1 on errors.
`;
}

/** Upper bounds that keep a mistyped digit from starting a run that never ends. */
const LIMITS: Record<string, number | undefined> = {
  "--cycles": 100,
  "--requests": 1_000_000,
  "--connections": 10_000,
  "--idle": 3_600,
};

function findSpec(argument: string): FlagSpec | undefined {
  return FLAGS.find((spec) => spec.flag === argument || spec.alias === argument);
}

export function parseCliArgs(argv: string[]): ParsedCli {
  const options: CliRunOptions = {
    appDir: "",
    routes: null,
    cycles: null,
    requests: null,
    connections: null,
    idleSeconds: null,
    quick: false,
    diffAll: false,
    output: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("-")) {
      if (options.appDir !== "") {
        return { kind: "error", message: `unexpected extra argument "${argument}" — one app directory only` };
      }
      options.appDir = argument;
      continue;
    }

    const spec = findSpec(argument);
    if (spec === undefined) {
      return { kind: "error", message: `unknown option "${argument}" — see --help` };
    }
    if (spec.flag === "--help") {
      return { kind: "help" };
    }
    if (spec.flag === "--version") {
      return { kind: "version" };
    }

    let value = "";
    if (spec.value !== "none") {
      value = argv[index + 1] ?? "";
      index += 1;
      // A negative number is a bad value, not a missing one — say so plainly.
      const looksNegativeNumber = /^-\d+(\.\d+)?$/.test(value);
      if (value === "" || (value.startsWith("-") && !looksNegativeNumber)) {
        return { kind: "error", message: `option "${spec.flag}" needs a value ${spec.argName ?? ""}` };
      }
    }

    switch (spec.flag) {
      case "--routes": {
        const routes = value.split(",").map((route) => route.trim()).filter((route) => route !== "");
        if (routes.length === 0) {
          // Silently measuring everything after an empty selector was a trap.
          return { kind: "error", message: `option "--routes" needs at least one route` };
        }
        options.routes = routes;
        break;
      }
      case "--cycles":
      case "--requests":
      case "--connections":
      case "--idle": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return { kind: "error", message: `option "${spec.flag}" needs a positive integer, got "${value}"` };
        }
        const maximum = LIMITS[spec.flag];
        if (maximum !== undefined && parsed > maximum) {
          return {
            kind: "error",
            message: `option "${spec.flag}" is capped at ${maximum} (got ${parsed}) — a run that large would never finish`,
          };
        }
        if (spec.flag === "--cycles" && parsed < 3) {
          return { kind: "error", message: "the trend verdict needs at least 3 cycles (--cycles 3 or more)" };
        }
        if (spec.flag === "--cycles") options.cycles = parsed;
        if (spec.flag === "--requests") options.requests = parsed;
        if (spec.flag === "--connections") options.connections = parsed;
        if (spec.flag === "--idle") options.idleSeconds = parsed;
        break;
      }
      case "--quick":
        options.quick = true;
        break;
      case "--diff-all":
        options.diffAll = true;
        break;
      case "--output":
        options.output = value;
        break;
    }
  }

  if (options.appDir === "") {
    return { kind: "help" };
  }
  return { kind: "run", options };
}
