import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const controlFileSchema = z.object({ port: z.number(), pid: z.number() });

/**
 * Old-space cap for measured processes, when the caller does not pick one.
 *
 * Small on purpose: a leak that would take a production container an hour to
 * kill reaches a 512 MB ceiling in minutes. It is a default, not a constant —
 * an app whose legitimate working set is larger cannot be measured under it,
 * so `--max-old-space` exists and the chosen value is recorded in `run.json`.
 */
export const DEFAULT_MAX_OLD_SPACE_MB = 512;

/**
 * How long each startup wait gets before the route is called failed.
 *
 * It was 15 s, shared between waiting for the control channel and waiting for
 * the app to listen — so a slow channel spent the app's budget too. Both
 * numbers were also invisible: a real app that needs longer to boot than the
 * tool was willing to wait had no way to say so, and got
 * `timed out waiting for app` on every route (#71). 60 s is what a cold
 * standalone bundle of a couple of thousand modules takes on a laptop with
 * a busy disk, with room to spare; `--ready-timeout` moves it.
 */
export const DEFAULT_READY_TIMEOUT_MS = 60_000;

export type LaunchOptions = {
  /** Absolute path to the standalone `server.js` (or any PORT/HOSTNAME-honoring server). */
  serverPath: string;
  /** Directory for `control.json` and heap snapshots (`NEXT_LEAK_DIR`). */
  workDir: string;
  /** Port the measured app should listen on. */
  appPort: number;
  /** Path to the built bootstrap module loaded with `--import`. */
  bootstrapPath: string;
  hostname?: string;
  maxOldSpaceMb?: number;
  /**
   * Budget for each of the two waits below, not for the pair. Default:
   * `DEFAULT_READY_TIMEOUT_MS`.
   */
  readyTimeoutMs?: number;
  env?: Record<string, string>;
};

export type LaunchedApp = {
  pid: number;
  appPort: number;
  controlPort: number;
  /**
   * Why the measured process is gone, or null while it is alive. Without it
   * a child that died mid-run surfaces as "fetch failed", which reads like a
   * bug in the tool and hides the finding — most often that the app blew
   * through the heap limit the run configured.
   *
   * `heapExhausted` separates that one death from every other, because it is
   * the only one the run is allowed to call a verdict rather than a failure.
   */
  explainExit: () => RuntimeDeath | null;
  /** SIGTERM, then SIGKILL after a grace period. Resolves when the child exited. */
  close: () => Promise<void>;
};

/**
 * How the measured process died. `heapExhausted` is the one death that is a
 * measurement: the app did not fit in the limit the run gave it, which is the
 * finding the tool exists to produce. Every other death is a failure.
 */
export type RuntimeDeath = {
  reason: string;
  heapExhausted: boolean;
};

export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

const activeChildren = new Set<ChildProcess>();

/**
 * Characters of stderr kept from each end of the stream. 4096 comfortably
 * holds a fatal header (GC trace + FATAL line) on one side and the last
 * frames plus any explanatory epilogue on the other.
 */
const STDERR_WINDOW = 4096;

/** Interrupt safety: no measured-app process may outlive the CLI. */
export function killActiveChildren(): void {
  for (const child of activeChildren) {
    child.kill("SIGKILL");
  }
}

/**
 * Puts a process this tool spawned under the same interrupt safety as a
 * measured app — a build launched by `next-leak build` must not outlive a
 * Ctrl+C either.
 */
export function registerChild(child: ChildProcess): void {
  activeChildren.add(child);
  child.once("exit", () => activeChildren.delete(child));
}

export function unregisterChild(child: ChildProcess): void {
  activeChildren.delete(child);
}

/**
 * Turns a stack dump into a sentence when the cause is recognisable. Seen in
 * the wild: a webpack `output: standalone` build that ships without
 * `@swc/helpers`, which fails identically when started by hand — the tool is
 * the messenger, and should say so instead of printing 20 lines of trace.
 */
export function explainStartupFailure(stderr: string): string {
  const missingModule = /Cannot find module '([^']+)'/.exec(stderr);
  if (missingModule !== null) {
    return (
      `the standalone build is missing a dependency (${missingModule[1]}). ` +
      `This is a build problem, not a measurement one: \`node .next/standalone/server.js\` ` +
      `fails the same way on its own. Rebuild, or copy the missing package into ` +
      `.next/standalone/node_modules.`
    );
  }
  if (/EADDRINUSE/.test(stderr)) {
    return "the port was taken by another process while starting.";
  }
  return `stderr:\n${stderr}`;
}

/**
 * Same idea as `explainStartupFailure`, for a process that died *during* a
 * run. Heap exhaustion is the one death this tool can name outright, and it
 * is a finding rather than an accident: the app did not fit in the limit the
 * run gave it.
 */
/**
 * Whether a stderr window carries V8's own fatal heap message. The build path
 * asks the same question of build output in `build-verdict.ts`; the two are
 * deliberately not shared yet, because `launcher` importing the build verdict
 * would couple the runtime path to it for one regex.
 */
export function stderrShowsHeapExhaustion(stderr: string): boolean {
  return /heap out of memory|Reached heap limit|Ineffective mark-compacts/i.test(stderr);
}

export function explainRuntimeFailure(stderr: string, maxOldSpaceMb: number): string {
  if (stderrShowsHeapExhaustion(stderr)) {
    return (
      `the measured process ran out of heap and was killed by V8 mid-run ` +
      `(limit in force: --max-old-space-size=${maxOldSpaceMb} MB). That is the ` +
      `measurement: this route does not fit in ${maxOldSpaceMb} MB under this load. ` +
      `Raise it with --max-old-space <mb> to match your deployment, or lower ` +
      `--requests/--connections to measure a lighter regime.`
    );
  }
  return `the measured process exited mid-run. ${explainStartupFailure(stderr)}`;
}

/**
 * What to say when the process is alive and answering on its control channel,
 * but never opened the app port. The old message named the port and stopped
 * there, which reads like the tool failed to connect to something that was
 * running. The process is up: what did not happen is the listen.
 */
export function appNeverListened(
  hostname: string,
  port: number,
  budgetMs: number,
  stderr: string
): string {
  const head =
    `app on ${hostname}:${port} — the process started and answered on its control ` +
    `channel, but never listened within ${Math.round(budgetMs / 1000)}s`;
  // The app usually said why, on a stream this process has been buffering all
  // along. It was only ever printed when the child exited, so a boot that hung
  // instead of dying — the exact case this message covers — threw the
  // explanation away and left the user with a port number (#71).
  if (stderr.trim() !== "") {
    return `${head}. It wrote this while starting:\n${stderr.trim()}`;
  }
  return (
    `${head}, and wrote nothing to stderr. An app that boots slower than that ` +
    `needs a larger budget: --ready-timeout <seconds>. Otherwise it is hanging ` +
    `during startup — starting the same server.js by hand, with PORT set, hangs ` +
    `the same way and can be interrupted to see where`
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `describe` is called at the moment of the timeout, not before it: what the
 * failure should say can depend on what the process did while being waited on.
 */
async function pollUntil<T>(
  deadline: number,
  describe: () => string,
  probe: () => Promise<T | undefined>,
  failed: () => string | undefined
): Promise<T> {
  for (;;) {
    const failure = failed();
    if (failure !== undefined) {
      throw new LaunchError(failure);
    }
    const result = await probe();
    if (result !== undefined) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new LaunchError(`timed out waiting for ${describe()}`);
    }
    await sleep(100);
  }
}

/**
 * Spawns the measured server in a fresh child process with GC exposed and the
 * control-channel bootstrap preloaded, and waits until both the app port and
 * the control channel respond.
 */
export async function launchInstrumented(options: LaunchOptions): Promise<LaunchedApp> {
  const hostname = options.hostname ?? "127.0.0.1";
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--expose-gc",
      `--max-old-space-size=${options.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB}`,
      "--import",
      pathToFileURL(options.bootstrapPath).href,
      options.serverPath,
    ],
    {
      cwd: path.dirname(options.serverPath),
      env: {
        ...process.env,
        ...options.env,
        NODE_ENV: "production",
        PORT: String(options.appPort),
        HOSTNAME: hostname,
        NEXT_LEAK_DIR: options.workDir,
      },
      stdio: ["ignore", "ignore", "pipe"],
    }
  );

  // Head AND tail, not tail alone. A real V8 fatal dump puts its one
  // load-bearing line ("FATAL ERROR: ... heap out of memory") ahead of ~75
  // native stack frames, several thousand characters before the end — a
  // tail-only window showed an anonymous C++ stack and the OOM recognition
  // below never fired. Found measuring the vercel/next.js#89091 repro, whose
  // measured process died at the cap and was reported as a generic exit.
  let stderrHead = "";
  let stderrTailBuffer = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (stderrHead.length < STDERR_WINDOW) {
      stderrHead = (stderrHead + text).slice(0, STDERR_WINDOW);
    }
    stderrTailBuffer = (stderrTailBuffer + text).slice(-STDERR_WINDOW);
  });
  const stderrWindow = (): string =>
    stderrHead === stderrTailBuffer || stderrTailBuffer === ""
      ? stderrHead
      : `${stderrHead}\n[...]\n${stderrTailBuffer}`;
  let exited = false;
  activeChildren.add(child);
  child.once("exit", () => {
    exited = true;
    activeChildren.delete(child);
  });
  const failed = (): string | undefined =>
    exited ? `server exited before becoming ready. ${explainStartupFailure(stderrWindow())}` : undefined;

  try {
    const controlPort = await pollUntil(
      Date.now() + readyTimeoutMs,
      () => `control channel in ${options.workDir}`,
      // Several processes may announce a channel (clustered servers); accept
      // the first one that actually answers instead of trusting a filename.
      async () => {
        let entries: string[];
        try {
          entries = (await readdir(options.workDir)).filter(
            (entry) => entry.startsWith("control-") && entry.endsWith(".json")
          );
        } catch {
          return undefined;
        }
        for (const entry of entries) {
          try {
            const parsed = controlFileSchema.parse(
              JSON.parse(await readFile(path.join(options.workDir, entry), "utf8"))
            );
            const response = await fetch(`http://127.0.0.1:${parsed.port}/gc`);
            if (response.ok) {
              return parsed.port;
            }
          } catch {
            continue;
          }
        }
        return undefined;
      },
      failed
    );

    // Its own budget, started here. The control channel comes up when the
    // bootstrap is imported, which is before the app has loaded a single
    // module of its own — so the time the channel took says nothing about
    // how long the app needs, and must not be deducted from it.
    await pollUntil(
      Date.now() + readyTimeoutMs,
      () => appNeverListened(hostname, options.appPort, readyTimeoutMs, stderrWindow()),
      async () => {
        try {
          await fetch(`http://${hostname}:${options.appPort}/`, { method: "HEAD" });
          return true;
        } catch {
          return undefined;
        }
      },
      failed
    );

    return {
      pid: child.pid ?? -1,
      appPort: options.appPort,
      controlPort,
      explainExit: () => {
        if (!exited) {
          return null;
        }
        const stderr = stderrWindow();
        return {
          reason: explainRuntimeFailure(
            stderr,
            options.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB
          ),
          heapExhausted: stderrShowsHeapExhaustion(stderr),
        };
      },
      close: async () => {
        if (exited) {
          return;
        }
        const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
        await gone;
        clearTimeout(killTimer);
      },
    };
  } catch (cause) {
    child.kill("SIGKILL");
    throw cause;
  }
}
