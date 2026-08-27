import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runRitual, type RitualOptions, type RitualResult } from "./ritual.js";
import type { TrendVerdict } from "./trend.js";

/**
 * A server that leaks on purpose, written out at run time.
 *
 * Kept as a template rather than a file under `src/` because a file has to
 * survive tsup, the published tarball and the pack smoke test to be there when
 * a user runs the check; a string cannot be dropped by a build step.
 *
 * The retention pattern is the phase-0 one the whole tool was validated
 * against: `Buffer.alloc().toString()` materializes a real 8 KB string, where
 * `"z".repeat(8192)` would give V8 a ~400 byte cons rope and leak almost
 * nothing.
 */
export const SELF_CHECK_SERVER = `import http from "node:http";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? "127.0.0.1";

const retained = [];

http
  .createServer((req, res) => {
    retained.push(Buffer.alloc(8192, retained.length & 0xff).toString("latin1"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ retained: retained.length }));
  })
  .listen(port, hostname);
`;

/** Bytes the planted server retains per request. */
export const PLANTED_LEAK_BYTES_PER_REQUEST = 8192;

export type SelfCheckResult = {
  /** True when the harness detected the leak it planted. */
  passed: boolean;
  verdict: TrendVerdict;
  growthPer1000Requests: number;
  /** What the run should say about it, pass or fail. */
  summary: string;
};

export type SelfCheckOptions = {
  bootstrapPath: string;
  appPort: number;
  warmupRequests?: number;
  loadRequests?: number;
  connections?: number;
  cycles?: number;
  idleMs?: number;
  maxOldSpaceMb?: number;
};

export type SelfCheckDeps = {
  ritual: (options: RitualOptions) => Promise<RitualResult>;
};

const defaultDeps: SelfCheckDeps = { ritual: runRitual };

/**
 * Measures a leak of known size in the environment the user is measuring from.
 *
 * A `stable` verdict means one of two things — the app does not leak, or the
 * measurement does not work — and nothing in a run tells them apart. This
 * plants 8 KB per request and checks the ritual sees it, under the same Node
 * binary, heap cap, concurrency and container limits a real run would use.
 *
 * A failure here is not a warning about this route. It says every verdict from
 * this environment is worthless, which is worth knowing before acting on one.
 */
export async function runSelfCheck(
  options: SelfCheckOptions,
  deps: SelfCheckDeps = defaultDeps
): Promise<SelfCheckResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "next-leak-self-check-"));
  const serverPath = path.join(dir, "server.js");
  try {
    await writeFile(serverPath, SELF_CHECK_SERVER);
    const result = await deps.ritual({
      serverPath,
      route: "/",
      workDir: path.join(dir, "run"),
      bootstrapPath: options.bootstrapPath,
      appPort: options.appPort,
      ...(options.warmupRequests !== undefined && { warmupRequests: options.warmupRequests }),
      ...(options.loadRequests !== undefined && { loadRequests: options.loadRequests }),
      ...(options.connections !== undefined && { connections: options.connections }),
      ...(options.cycles !== undefined && { cycles: options.cycles }),
      ...(options.idleMs !== undefined && { idleMs: options.idleMs }),
      ...(options.maxOldSpaceMb !== undefined && { maxOldSpaceMb: options.maxOldSpaceMb }),
    });

    const growthPer1000Requests =
      (result.trend.growthPerCycle / result.requestsPerCycle) * 1000;
    const rate = `${(growthPer1000Requests / (1024 * 1024)).toFixed(2)} MB/1000 req`;
    const passed = result.trend.verdict === "leak";

    return {
      passed,
      verdict: result.trend.verdict,
      growthPer1000Requests,
      summary: passed
        ? `harness verified: the planted leak was detected at ${rate}`
        : `harness NOT verified: a leak of ${PLANTED_LEAK_BYTES_PER_REQUEST} bytes per ` +
          `request came back ${result.trend.verdict} at ${rate}. Verdicts measured in ` +
          `this environment cannot be trusted — a flat curve here means the measurement ` +
          `is not working, not that nothing leaks`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
