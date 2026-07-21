#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { helpText, parseCliArgs, type ParsedCli } from "./cli-args.js";
import { checkRuntime } from "./guards.js";
import { killActiveChildren } from "./launcher.js";
import { formatReport } from "./report.js";
import { RouteConfigError } from "./route-config.js";
import { runMeasurement } from "./runner.js";
import { TargetError } from "./target.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const HEADROOM_SENTINEL = "NEXT_LEAK_WITH_HEADROOM";
const HEADROOM_MB = 8192;

function hasHeapHeadroom(): boolean {
  return (
    process.execArgv.some((argument) => argument.includes("--max-old-space-size")) ||
    (process.env.NODE_OPTIONS ?? "").includes("--max-old-space-size") ||
    process.env[HEADROOM_SENTINEL] === "1"
  );
}

/**
 * Diffing large heap snapshots needs more old-space than Node's default.
 * Re-exec once with headroom; the sentinel prevents loops, and signals are
 * forwarded so Ctrl+C still reaches the real run.
 */
function reexecWithHeadroom(): void {
  const child = spawn(process.execPath, [`--max-old-space-size=${HEADROOM_MB}`, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, [HEADROOM_SENTINEL]: "1" },
  });
  for (const signalName of ["SIGINT", "SIGTERM"] as const) {
    process.on(signalName, () => child.kill(signalName));
  }
  child.once("exit", (code, signal) => {
    process.exit(code ?? (signal === "SIGINT" ? 130 : 1));
  });
}

/**
 * First Ctrl+C aborts gracefully (partial run.json survives); the second
 * exits hard for the case where teardown itself is stuck.
 */
function installInterruptHandlers(): AbortController {
  const aborter = new AbortController();
  let interrupts = 0;
  for (const signalName of ["SIGINT", "SIGTERM"] as const) {
    process.on(signalName, () => {
      interrupts += 1;
      if (interrupts > 1) {
        process.exit(130);
      }
      console.error("\n· interrupted — stopping the measured process and writing a partial run.json");
      aborter.abort();
      killActiveChildren();
    });
  }
  return aborter;
}

/** Prints the outcome of non-run commands; true when main should stop here. */
function handleNonRunCommand(parsed: ParsedCli): boolean {
  if (parsed.kind === "version") {
    console.log(version);
    return true;
  }
  if (parsed.kind === "help") {
    console.log(helpText(version));
    process.exitCode = process.argv.length > 2 ? 0 : 1;
    return true;
  }
  if (parsed.kind === "error") {
    console.error(`error: ${parsed.message}`);
    process.exitCode = 1;
    return true;
  }
  const guardFailure = checkRuntime();
  if (guardFailure !== null) {
    console.error(`error: ${guardFailure}`);
    process.exitCode = 1;
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (handleNonRunCommand(parsed) || parsed.kind !== "run") {
    return;
  }
  if (!hasHeapHeadroom()) {
    reexecWithHeadroom();
    return;
  }

  const aborter = installInterruptHandlers();

  const { options } = parsed;
  // The exact profile the real-app revalidation ran with (22 routes, zero
  // false positives): rigorous enough to trust, fast enough to finish over
  // coffee. Explicit flags override it, so `--quick --cycles 6` works.
  const quickPreset = options.quick
    ? { loadRequests: 2000, cycles: 4, idleMs: 8000 }
    : {};
  const report = await runMeasurement({
    appDir: options.appDir,
    bootstrapPath: fileURLToPath(new URL("./bootstrap.js", import.meta.url)),
    signal: aborter.signal,
    ...quickPreset,
    ...(options.routes !== null && { routeFilter: options.routes }),
    ...(options.cycles !== null && { cycles: options.cycles }),
    ...(options.requests !== null && { loadRequests: options.requests }),
    ...(options.connections !== null && { connections: options.connections }),
    ...(options.idleSeconds !== null && { idleMs: options.idleSeconds * 1000 }),
    ...(options.diffAll && { diffAll: true }),
    ...(options.output !== null && { outputDir: options.output }),
    onProgress: (message) => console.error(`· ${message}`),
  });
  console.log(formatReport(report));
  if (aborter.signal.aborted) {
    process.exitCode = 130;
  }
}

main().catch((cause: unknown) => {
  if (cause instanceof TargetError || cause instanceof RouteConfigError) {
    console.error(`error: ${cause.message}`);
  } else {
    console.error(cause);
  }
  process.exitCode = 1;
});
