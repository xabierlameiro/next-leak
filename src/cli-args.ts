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

type FlagOutcome = { kind: "ok" } | { kind: "error"; message: string };

const flagError = (message: string): FlagOutcome => ({ kind: "error", message });
const FLAG_OK: FlagOutcome = { kind: "ok" };

function applyRoutesFlag(value: string, options: CliRunOptions): FlagOutcome {
  const routes = value.split(",").map((route) => route.trim()).filter((route) => route !== "");
  if (routes.length === 0) {
    // Silently measuring everything after an empty selector was a trap.
    return flagError(`option "--routes" needs at least one route`);
  }
  options.routes = routes;
  return FLAG_OK;
}

function applyNumericFlag(flag: string, value: string, options: CliRunOptions): FlagOutcome {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return flagError(`option "${flag}" needs a positive integer, got "${value}"`);
  }
  const maximum = LIMITS[flag];
  if (maximum !== undefined && parsed > maximum) {
    return flagError(
      `option "${flag}" is capped at ${maximum} (got ${parsed}) — a run that large would never finish`
    );
  }
  if (flag === "--cycles" && parsed < 3) {
    return flagError("the trend verdict needs at least 3 cycles (--cycles 3 or more)");
  }
  if (flag === "--cycles") options.cycles = parsed;
  if (flag === "--requests") options.requests = parsed;
  if (flag === "--connections") options.connections = parsed;
  if (flag === "--idle") options.idleSeconds = parsed;
  return FLAG_OK;
}

function applyFlag(spec: FlagSpec, value: string, options: CliRunOptions): FlagOutcome {
  switch (spec.flag) {
    case "--routes":
      return applyRoutesFlag(value, options);
    case "--cycles":
    case "--requests":
    case "--connections":
    case "--idle":
      return applyNumericFlag(spec.flag, value, options);
    case "--quick":
      options.quick = true;
      return FLAG_OK;
    case "--diff-all":
      options.diffAll = true;
      return FLAG_OK;
    case "--output":
      options.output = value;
      return FLAG_OK;
    default:
      return FLAG_OK;
  }
}

/** Reads the value token following a flag, validating it looks like a value. */
function readFlagValue(spec: FlagSpec, argv: string[], index: number): { value: string } | { error: string } {
  if (spec.value === "none") {
    return { value: "" };
  }
  const value = argv[index + 1] ?? "";
  // A negative number is a bad value, not a missing one — say so plainly.
  const looksNegativeNumber = /^-\d+(\.\d+)?$/.test(value);
  if (value === "" || (value.startsWith("-") && !looksNegativeNumber)) {
    return { error: `option "${spec.flag}" needs a value ${spec.argName ?? ""}` };
  }
  return { value };
}

type FlagStep = { consumed: number } | { done: ParsedCli };

/** Processes one flag token; returns extra tokens consumed or an early exit. */
function parseFlagAt(argv: string[], index: number, options: CliRunOptions): FlagStep {
  const argument = argv[index] ?? "";
  const spec = findSpec(argument);
  if (spec === undefined) {
    return { done: { kind: "error", message: `unknown option "${argument}" — see --help` } };
  }
  if (spec.flag === "--help") {
    return { done: { kind: "help" } };
  }
  if (spec.flag === "--version") {
    return { done: { kind: "version" } };
  }
  const read = readFlagValue(spec, argv, index);
  if ("error" in read) {
    return { done: { kind: "error", message: read.error } };
  }
  const outcome = applyFlag(spec, read.value, options);
  if (outcome.kind === "error") {
    return { done: { kind: "error", message: outcome.message } };
  }
  return { consumed: spec.value === "none" ? 0 : 1 };
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
    const step = parseFlagAt(argv, index, options);
    if ("done" in step) {
      return step.done;
    }
    index += step.consumed;
  }

  if (options.appDir === "") {
    return { kind: "help" };
  }
  return { kind: "run", options };
}
