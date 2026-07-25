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
   */
  explainExit: () => string | null;
  /** SIGTERM, then SIGKILL after a grace period. Resolves when the child exited. */
  close: () => Promise<void>;
};

export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

const activeChildren = new Set<ChildProcess>();

/** Interrupt safety: no measured-app process may outlive the CLI. */
export function killActiveChildren(): void {
  for (const child of activeChildren) {
    child.kill("SIGKILL");
  }
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
export function explainRuntimeFailure(stderr: string, maxOldSpaceMb: number): string {
  if (/heap out of memory|Reached heap limit|Ineffective mark-compacts/i.test(stderr)) {
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntil<T>(
  deadline: number,
  what: string,
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
      throw new LaunchError(`timed out waiting for ${what}`);
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
  const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);

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

  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });
  let exited = false;
  activeChildren.add(child);
  child.once("exit", () => {
    exited = true;
    activeChildren.delete(child);
  });
  const failed = (): string | undefined =>
    exited ? `server exited before becoming ready. ${explainStartupFailure(stderrTail)}` : undefined;

  try {
    const controlPort = await pollUntil(
      deadline,
      `control channel in ${options.workDir}`,
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

    await pollUntil(
      deadline,
      `app on ${hostname}:${options.appPort}`,
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
      explainExit: () =>
        exited
          ? explainRuntimeFailure(stderrTail, options.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB)
          : null,
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
