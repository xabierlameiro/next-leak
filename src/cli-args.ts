export type CliRunOptions = {
  appDir: string;
  routes: string[] | null;
  cycles: number | null;
  requests: number | null;
  connections: number | null;
  idleSeconds: number | null;
  maxOldSpaceMb: number | null;
  quick: boolean;
  noResolve: boolean;
  diffAll: boolean;
  output: string | null;
};

export type CliBuildOptions = {
  appDir: string;
  output: string | null;
};

export type ParsedCli =
  | { kind: "run"; options: CliRunOptions }
  | { kind: "build"; options: CliBuildOptions }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

/** The command name that switches from measuring a server to measuring a build. */
const BUILD_COMMAND = "build";

/**
 * Flags that shape HTTP load or the per-route ritual, and so mean nothing to a
 * build. Rejected by name rather than ignored: silently dropping a flag someone
 * typed is how a run ends up measuring something other than what was asked.
 */
const RUN_ONLY_FLAGS: ReadonlyArray<[keyof CliRunOptions, string]> = [
  ["routes", "--routes"],
  ["cycles", "--cycles"],
  ["requests", "--requests"],
  ["connections", "--connections"],
  ["idleSeconds", "--idle"],
  ["maxOldSpaceMb", "--max-old-space"],
  ["quick", "--quick"],
  ["noResolve", "--no-resolve"],
  ["diffAll", "--diff-all"],
];

function runOnlyFlagUsed(options: CliRunOptions): string | null {
  for (const [field, flag] of RUN_ONLY_FLAGS) {
    const value = options[field];
    if (value !== null && value !== false) {
      return flag;
    }
  }
  return null;
}

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
  { flag: "--cycles", value: "int", argName: "<n>", help: "Load cycles per route (default 4, minimum 3)" },
  { flag: "--requests", value: "int", argName: "<n>", help: "Requests per cycle (default 5000)" },
  { flag: "--connections", value: "int", argName: "<n>", help: "Concurrent connections (default 100)" },
  { flag: "--idle", value: "int", argName: "<seconds>", help: "Idle seconds before each sample (default 30)" },
  {
    flag: "--max-old-space",
    value: "int",
    argName: "<mb>",
    help: "Heap cap of each measured process (default 512) — raise it for apps whose working set is larger",
  },
  {
    flag: "--quick",
    value: "none",
    help: "Fast preset: 2000 requests x 4 cycles, 8s idle — same cycle count as the default, less traffic per cycle",
  },
  { flag: "--diff-all", value: "none", help: "Diff snapshots for stable routes too (slow)" },
  {
    flag: "--no-resolve",
    value: "none",
    help: "Do not re-measure inconclusive routes with more cycles (default: re-measure once)",
  },
  { flag: "--output", value: "string", argName: "<dir>", help: "Where to write runs (default <app-dir>/.next-leak)" },
  { flag: "--help", alias: "-h", value: "none", help: "Show this help" },
  { flag: "--version", alias: "-v", value: "none", help: "Print the version" },
];

export function helpText(version: string): string {
  const rows = FLAGS.map((spec) => {
    const alias = spec.alias ? `${spec.alias}, ` : "";
    const argName = spec.argName ? ` ${spec.argName}` : "";
    const left = `${alias}${spec.flag}${argName}`;
    return `  ${left.padEnd(26)}${spec.help}`;
  }).join("\n");
  return `next-leak ${version}

Find out whether your Next.js app actually leaks memory — how much, on which
route, and whose fault it is.

Usage:
  next-leak <app-dir> [options]        measure a built server under load
  next-leak build <app-dir>            measure the memory of "next build"

The app must be built with output: "standalone" (next build). For each
discovered route, next-leak boots a fresh instrumented process and runs:
warm-up → GC → baseline snapshot → [load → idle → GC → sample] × cycles →
snapshot. Evidence (report.html, ISSUE drafts, raw snapshots, run.json) is
written under the output directory.

The build command needs neither a previous build nor standalone output: it runs
the build itself and samples the resident memory of each static-generation
worker, which is where large sites run out of heap while prerendering. It takes
--output only; the options below shape HTTP load and do not apply to it.

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
  "--max-old-space": 65_536,
};

/**
 * Below this the measured process cannot hold a Next.js server plus the heap
 * snapshot machinery, and every route dies as an OOM the report would blame on
 * the app.
 */
const MIN_MAX_OLD_SPACE_MB = 128;

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
  if (flag === "--max-old-space" && parsed < MIN_MAX_OLD_SPACE_MB) {
    return flagError(
      `option "--max-old-space" needs at least ${MIN_MAX_OLD_SPACE_MB} MB (got ${parsed}) — ` +
        `below that the measured app cannot start`
    );
  }
  if (flag === "--cycles") options.cycles = parsed;
  if (flag === "--requests") options.requests = parsed;
  if (flag === "--connections") options.connections = parsed;
  if (flag === "--idle") options.idleSeconds = parsed;
  if (flag === "--max-old-space") options.maxOldSpaceMb = parsed;
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
    case "--max-old-space":
      return applyNumericFlag(spec.flag, value, options);
    case "--quick":
      options.quick = true;
      return FLAG_OK;
    case "--diff-all":
      options.diffAll = true;
      return FLAG_OK;
    case "--no-resolve":
      options.noResolve = true;
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
  // `next-leak build <dir>` measures a build; anything else keeps the original
  // meaning. Only an exact first token counts, so a directory named "build" is
  // still reachable as `next-leak ./build`.
  const isBuild = argv[0] === BUILD_COMMAND;
  const rest = isBuild ? argv.slice(1) : argv;
  const options: CliRunOptions = {
    appDir: "",
    routes: null,
    cycles: null,
    requests: null,
    connections: null,
    idleSeconds: null,
    maxOldSpaceMb: null,
    quick: false,
    noResolve: false,
    diffAll: false,
    output: null,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? "";
    if (!argument.startsWith("-")) {
      if (options.appDir !== "") {
        return { kind: "error", message: `unexpected extra argument "${argument}" — one app directory only` };
      }
      options.appDir = argument;
      continue;
    }
    const step = parseFlagAt(rest, index, options);
    if ("done" in step) {
      return step.done;
    }
    index += step.consumed;
  }

  if (options.appDir === "") {
    return { kind: "help" };
  }
  if (isBuild) {
    const misplaced = runOnlyFlagUsed(options);
    if (misplaced !== null) {
      return {
        kind: "error",
        message: `option "${misplaced}" shapes HTTP load and does not apply to "next-leak build" — see --help`,
      };
    }
    return { kind: "build", options: { appDir: options.appDir, output: options.output } };
  }
  return { kind: "run", options };
}
