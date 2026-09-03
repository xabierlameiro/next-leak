export type CliRunOptions = {
  appDir: string;
  routes: string[] | null;
  cycles: number | null;
  /**
   * How many times to measure each route, from a fresh server each time.
   *
   * More cycles watch one process for longer; repetitions watch different
   * processes. The spreads that make a verdict unpublishable live between
   * processes: vercel/next.js#84648 gave 602, 826 and 875 MB on three runs of
   * one build and 39 MB on a fourth.
   */
  repeat: number | null;
  requests: number | null;
  connections: number | null;
  idleSeconds: number | null;
  warmupRequests: number | null;
  maxOldSpaceMb: number | null;
  quick: boolean;
  noResolve: boolean;
  selfCheck: boolean;
  diffAll: boolean;
  attributeBuild: boolean;
  writeConfig: boolean;
  output: string | null;
};

export type CliBuildOptions = {
  appDir: string;
  output: string | null;
  /** Opt-in: signal the worker for snapshots and name what it retains. */
  attributeBuild: boolean;
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
  ["repeat", "--repeat"],
  ["requests", "--requests"],
  ["connections", "--connections"],
  ["idleSeconds", "--idle"],
  ["warmupRequests", "--warmup"],
  ["maxOldSpaceMb", "--max-old-space"],
  ["quick", "--quick"],
  ["noResolve", "--no-resolve"],
  ["selfCheck", "--self-check"],
  ["diffAll", "--diff-all"],
  ["writeConfig", "--write-config"],
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
  {
    flag: "--repeat",
    value: "int",
    argName: "<n>",
    help:
      "Measure each route n times from a fresh server (default 1) — the run takes n times as long, " +
      "and routes whose repetitions disagree are reported inconclusive",
  },
  { flag: "--requests", value: "int", argName: "<n>", help: "Requests per cycle (default 5000)" },
  { flag: "--connections", value: "int", argName: "<n>", help: "Concurrent connections (default 100)" },
  { flag: "--idle", value: "int", argName: "<seconds>", help: "Idle seconds before each sample (default 30)" },
  {
    flag: "--warmup",
    value: "int",
    argName: "<n>",
    help: "Requests before the baseline snapshot (default 200) — lower it on apps that cache per request",
  },
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
    flag: "--attribute",
    value: "none",
    help: "build only: also name what the worker retains — signals it for heap snapshots, which can stall the build",
  },
  {
    flag: "--no-resolve",
    value: "none",
    help: "Do not re-measure inconclusive routes with more cycles (default: re-measure once)",
  },
  {
    flag: "--self-check",
    value: "none",
    help: "Measure a planted leak first to prove the harness works here — costs one extra route's worth of time",
  },
  { flag: "--output", value: "string", argName: "<dir>", help: "Where to write runs (default <app-dir>/.next-leak)" },
  {
    flag: "--write-config",
    value: "none",
    help: "Write next-leak.config.json for the routes that need sample params, then exit (never overwrites)",
  },
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
  "--repeat": 10,
  "--requests": 1_000_000,
  "--connections": 10_000,
  "--idle": 3_600,
  "--warmup": 1_000_000,
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
  if (flag === "--repeat") options.repeat = parsed;
  if (flag === "--requests") options.requests = parsed;
  if (flag === "--connections") options.connections = parsed;
  if (flag === "--idle") options.idleSeconds = parsed;
  if (flag === "--warmup") options.warmupRequests = parsed;
  if (flag === "--max-old-space") options.maxOldSpaceMb = parsed;
  return FLAG_OK;
}

function applyFlag(spec: FlagSpec, value: string, options: CliRunOptions): FlagOutcome {
  switch (spec.flag) {
    case "--routes":
      return applyRoutesFlag(value, options);
    case "--cycles":
    case "--repeat":
    case "--requests":
    case "--connections":
    case "--idle":
    case "--warmup":
    case "--max-old-space":
      return applyNumericFlag(spec.flag, value, options);
    case "--quick":
      options.quick = true;
      return FLAG_OK;
    case "--diff-all":
      options.diffAll = true;
      return FLAG_OK;
    case "--attribute":
      options.attributeBuild = true;
      return FLAG_OK;
    case "--write-config":
      options.writeConfig = true;
      return FLAG_OK;
    case "--self-check":
      options.selfCheck = true;
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
    repeat: null,
    requests: null,
    connections: null,
    idleSeconds: null,
    warmupRequests: null,
    maxOldSpaceMb: null,
    quick: false,
    noResolve: false,
    selfCheck: false,
    diffAll: false,
    attributeBuild: false,
    writeConfig: false,
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
    return {
      kind: "build",
      options: {
        appDir: options.appDir,
        output: options.output,
        attributeBuild: options.attributeBuild,
      },
    };
  }
  return { kind: "run", options };
}
