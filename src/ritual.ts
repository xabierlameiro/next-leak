import { mkdir } from "node:fs/promises";
import { requestGc, requestSnapshot } from "./control-client.js";
import type { HeapSample } from "./control-server.js";
import { launchInstrumented } from "./launcher.js";
import { runAbandonPhase, type AbandonPhaseResult } from "./abandon-load.js";
import { runLoadPhase } from "./load.js";
import { classifyMemoryTrend, type TrendResult } from "./trend.js";

export type RitualOptions = {
  /** Absolute path to the standalone server.js. */
  serverPath: string;
  /** Concrete request path (dynamic params already resolved), e.g. "/products/42". */
  route: string;
  /** Directory for this route's snapshots and control file. */
  workDir: string;
  /** Built bootstrap module for `--import`. */
  bootstrapPath: string;
  appPort: number;
  warmupRequests?: number;
  loadRequests?: number;
  connections?: number;
  cycles?: number;
  idleMs?: number;
  /** Headers sent with every request during warm-up and load. */
  headers?: Record<string, string>;
  /** Emulate clients that disconnect before the response arrives. */
  abandonAfterMs?: number;
};

export type PhaseTiming = {
  phase: string;
  seconds: number;
};

/** What each load phase actually did — auditable after the fact. */
export type LoadOutcome = {
  phase: string;
  sent: number;
  ok2xx?: number;
  non2xx?: number;
  errors?: number;
  timeouts?: number;
  abandoned?: number;
  /** Abandonments where the response had already started — the mid-stream path. */
  abandonedMidStream?: number;
};

/**
 * Whether the heap actually held still before each sample was taken.
 *
 * `unknown` is not a softer `moving`: with fewer than two GC readings there is
 * nothing to compare, so the run never learned whether the heap was steady.
 * Conflating the two made every short-idle run look like a moving heap.
 */
export type SettleStatus = "settled" | "moving" | "unknown";

export type SettleOutcome = {
  phase: string;
  status: SettleStatus;
  /** GC polls taken before converging or giving up. */
  polls: number;
};

/** Two readings are the minimum needed to call a heap steady. */
const MIN_POLLS_TO_JUDGE = 2;

export type RitualResult = {
  route: string;
  /** Wall-clock per phase, so slow runs can be explained instead of guessed. */
  timings: PhaseTiming[];
  /** Per-phase request outcomes; without these a run cannot be audited. */
  loadOutcomes: LoadOutcome[];
  /** Per-cycle settle results: a sample taken while the heap moved is suspect. */
  settleOutcomes: SettleOutcome[];
  /** Post-GC heapUsed per phase: baseline first, then one per cycle. */
  samples: number[];
  /** Full memory samples in the same order. */
  memorySamples: HeapSample[];
  baselineSnapshot: string;
  afterSnapshot: string;
  trend: TrendResult;
  requestsPerCycle: number;
};

/** Injectable seams for unit tests; production uses the real implementations. */
export type RitualDeps = {
  launch: typeof launchInstrumented;
  load: typeof runLoadPhase;
  sleep: (ms: number) => Promise<void>;
};

const SETTLE_POLL_MS = 2000;
const SETTLE_TOLERANCE = 0.01;

/**
 * Waits for post-load transients to drain, up to `maxIdleMs`.
 *
 * The idle period exists so buffers and keep-alive state are released before
 * sampling — measuring immediately is the classic false positive. Its *fixed
 * duration*, however, was pure margin: most of a run's wall clock was spent
 * waiting after the heap had already settled. Polling for stability keeps the
 * guarantee and returns as soon as it holds.
 */
async function waitUntilSettled(
  controlPort: number,
  maxIdleMs: number,
  deps: RitualDeps
): Promise<{ status: SettleStatus; polls: number }> {
  const deadline = Date.now() + maxIdleMs;
  let previous: number | null = null;
  let polls = 0;
  while (Date.now() < deadline) {
    await deps.sleep(Math.min(SETTLE_POLL_MS, Math.max(deadline - Date.now(), 0)));
    let current: number;
    try {
      current = (await requestGc(controlPort)).heapUsed;
    } catch {
      return { status: "unknown", polls }; // the app is gone; the caller surfaces the real failure
    }
    polls += 1;
    if (previous !== null && Math.abs(current - previous) <= previous * SETTLE_TOLERANCE) {
      return { status: "settled", polls };
    }
    previous = current;
  }
  // Budget spent. With two readings or more that means the heap kept moving,
  // and the next sample is of a process mid-flight. With fewer, the idle
  // budget was simply too short to ever compare two readings.
  return { status: polls >= MIN_POLLS_TO_JUDGE ? "moving" : "unknown", polls };
}

const defaultDeps: RitualDeps = {
  launch: launchInstrumented,
  load: runLoadPhase,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Single source of truth for ritual defaults — reports must echo them. */
export const RITUAL_DEFAULTS = {
  warmupRequests: 200,
  loadRequests: 5000,
  connections: 100,
  cycles: 3,
  idleMs: 30_000,
} as const;

/**
 * Runs the validated phase-0 ritual against one route in a fresh process:
 *
 *   warm-up → GC → baseline snapshot
 *   → [load → idle → GC → sample] × cycles (last cycle snapshots)
 *
 * Warm-up before the baseline and idle+GC before every sample are what
 * separate a real measurement from the classic false positive.
 */
export async function runRitual(
  options: RitualOptions,
  deps: RitualDeps = defaultDeps
): Promise<RitualResult> {
  const warmupRequests = options.warmupRequests ?? RITUAL_DEFAULTS.warmupRequests;
  const loadRequests = options.loadRequests ?? RITUAL_DEFAULTS.loadRequests;
  const connections = options.connections ?? RITUAL_DEFAULTS.connections;
  const cycles = options.cycles ?? RITUAL_DEFAULTS.cycles;
  const idleMs = options.idleMs ?? RITUAL_DEFAULTS.idleMs;
  if (cycles < 3) {
    throw new Error("the trend verdict needs at least 3 cycles");
  }

  await mkdir(options.workDir, { recursive: true });
  // A free port can be taken between probing it and the child binding it, so
  // one lost race must not fail the route.
  let app;
  try {
    app = await deps.launch({
      serverPath: options.serverPath,
      workDir: options.workDir,
      appPort: options.appPort,
      bootstrapPath: options.bootstrapPath,
    });
  } catch (cause) {
    if (!String(cause).includes("EADDRINUSE")) {
      throw cause;
    }
    app = await deps.launch({
      serverPath: options.serverPath,
      workDir: options.workDir,
      appPort: options.appPort + 1,
      bootstrapPath: options.bootstrapPath,
    });
  }

  const timings: PhaseTiming[] = [];
  const loadOutcomes: LoadOutcome[] = [];
  const settleOutcomes: SettleOutcome[] = [];

  // Abandonment needs raw sockets: autocannon's timeout is in whole seconds,
  // so a route answering in milliseconds is never actually abandoned.
  const abandonAfterMs = options.abandonAfterMs;
  const loadCycle = async (phase: string, amount: number): Promise<void> => {
    if (abandonAfterMs === undefined) {
      const outcome = await deps.load({
        url: `http://127.0.0.1:${app.appPort}${options.route}`,
        amount,
        connections,
        ...(options.headers !== undefined && { headers: options.headers }),
      });
      loadOutcomes.push({
        phase,
        sent: outcome.sent,
        ok2xx: outcome.ok2xx,
        non2xx: outcome.non2xx,
        errors: outcome.errors,
        timeouts: outcome.timeouts,
      });
      return;
    }
    const outcome: AbandonPhaseResult = await runAbandonPhase({
      url: `http://127.0.0.1:${app.appPort}${options.route}`,
      amount,
      connections,
      abandonAfterMs,
      ...(options.headers !== undefined && { headers: options.headers }),
    });
    loadOutcomes.push({
      phase,
      sent: outcome.sent,
      abandoned: outcome.abandoned,
      abandonedMidStream: outcome.abandonedMidStream,
      ok2xx: outcome.completed,
      errors: outcome.errors,
    });
  };
  const timed = async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await work();
    } finally {
      timings.push({ phase, seconds: Math.round((Date.now() - started) / 100) / 10 });
    }
  };

  try {
    const routeUrl = `http://127.0.0.1:${app.appPort}${options.route}`;

    await timed("warm-up", () =>
      deps.load({
        url: routeUrl,
        amount: warmupRequests,
        connections: 10,
        ...(options.headers !== undefined && { headers: options.headers }),
      })
    );
    const baseline = await timed("baseline snapshot", () =>
      requestSnapshot(app.controlPort, "baseline")
    );

    const memorySamples: HeapSample[] = [baseline.sample];
    let afterSnapshot = "";
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      await timed(`cycle ${cycle} load`, () => loadCycle(`cycle ${cycle}`, loadRequests));
      const settle = await timed(`cycle ${cycle} settle`, () =>
        waitUntilSettled(app.controlPort, idleMs, deps)
      );
      settleOutcomes.push({ phase: `cycle ${cycle}`, ...settle });

      if (cycle === cycles) {
        const after = await timed("after snapshot", () =>
          requestSnapshot(app.controlPort, "after")
        );
        afterSnapshot = after.file;
        memorySamples.push(after.sample);
      } else {
        memorySamples.push(await requestGc(app.controlPort));
      }
    }

    const samples = memorySamples.map((sample) => sample.heapUsed);
    // External memory counts too: a flat heap with growing buffers still OOMs.
    const externalSamples = memorySamples.map((sample) => sample.external);
    return {
      route: options.route,
      timings,
      loadOutcomes,
      settleOutcomes,
      samples,
      memorySamples,
      baselineSnapshot: baseline.file,
      afterSnapshot,
      trend: classifyMemoryTrend(samples, externalSamples),
      requestsPerCycle: loadRequests,
    };
  } finally {
    await app.close();
  }
}
