import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LaunchedApp } from "./launcher.js";
import type { LoadPhaseResult } from "./load.js";
import { runRitual, type RitualDeps } from "./ritual.js";

const MB = 1024 * 1024;

type Harness = {
  deps: RitualDeps;
  events: string[];
  closed: () => boolean;
  stop: () => Promise<void>;
};

/**
 * Scripted stand-in for the control channel: serves the phase-0 protocol with
 * a predetermined heapUsed sequence, so verdicts are deterministic and the
 * exact ritual order is observable.
 */
async function makeHarness(
  heapScript: number[],
  options: { failLoadCall?: number } = {}
): Promise<Harness> {
  const events: string[] = [];
  // The heap value advances once per load cycle, so settle probes and the
  // cycle sample observe the same value — as they do against a real process.
  let cycleIndex = 0;
  let closed = false;
  let loadCalls = 0;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://control.local");
    const heapUsed = heapScript[Math.min(cycleIndex, heapScript.length - 1)] ?? 0;
    const sample = { gcExposed: true, heapUsed, rss: 1, external: 1, arrayBuffers: 1 };
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/gc") {
      events.push("gc");
      response.end(JSON.stringify(sample));
      return;
    }
    const name = url.searchParams.get("name") ?? "?";
    events.push(`snapshot:${name}`);
    response.end(JSON.stringify({ file: `/fake/${name}.heapsnapshot`, sample }));
  });
  const controlPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve(address.port);
    });
  });

  const app: LaunchedApp = {
    pid: 1,
    appPort: 65_000,
    controlPort,
    close: async () => {
      closed = true;
    },
  };

  const okLoad: LoadPhaseResult = {
    sent: 0,
    ok2xx: 0,
    non2xx: 0,
    errors: 0,
    timeouts: 0,
    durationSeconds: 0,
  };

  const deps: RitualDeps = {
    launch: async () => app,
    load: async ({ amount }) => {
      loadCalls += 1;
      if (loadCalls === options.failLoadCall) {
        throw new Error("load failed");
      }
      events.push(`load:${amount}`);
      if (amount !== 200) {
        cycleIndex += 1;
      }
      return okLoad;
    },
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
    },
  };

  return {
    deps,
    events,
    closed: () => closed,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function baseOptions() {
  return {
    serverPath: "/fake/server.js",
    route: "/leaky",
    workDir: await mkdtemp(path.join(tmpdir(), "next-leak-ritual-")),
    bootstrapPath: "/fake/bootstrap.js",
    appPort: 65_000,
    idleMs: 5,
  };
}

describe("runRitual", () => {
  it("executes the validated phase order and wires the trend verdict", async () => {
    // Phase-0 leaky route shape: linear growth.
    harness = await makeHarness([29 * MB, 31 * MB, 33 * MB, 35 * MB]);
    const result = await runRitual(await baseOptions(), harness.deps);

    // The methodology, not the implementation: warm-up before the baseline,
    // and every sample preceded by load then a settle period with GC.
    const shape = harness.events.filter((event) => !event.startsWith("sleep:"));
    expect(shape[0]).toBe("load:200");
    expect(shape[1]).toBe("snapshot:baseline");
    expect(shape.filter((event) => event === "load:5000")).toHaveLength(3);
    expect(shape.at(-1)).toBe("snapshot:after");
    // At least one forced GC between each load and its sample.
    for (const [index, event] of shape.entries()) {
      if (event === "load:5000") {
        expect(shape.slice(index + 1, index + 3)).toContain("gc");
      }
    }
    expect(result.samples).toEqual([29 * MB, 31 * MB, 33 * MB, 35 * MB]);
    expect(result.trend.verdict).toBe("leak");
    expect(result.baselineSnapshot).toBe("/fake/baseline.heapsnapshot");
    expect(result.afterSnapshot).toBe("/fake/after.heapsnapshot");
    expect(result.timings.some((timing) => timing.phase === "warm-up")).toBe(true);
    expect(harness.closed()).toBe(true);
  });

  it("classifies a plateau shape as stable end to end", async () => {
    harness = await makeHarness([29.4 * MB, 31.5 * MB, 32.3 * MB, 32.1 * MB]);
    const result = await runRitual(await baseOptions(), harness.deps);
    expect(result.trend.verdict).toBe("stable");
  });

  it("tears the app down when a load phase fails", async () => {
    harness = await makeHarness([29 * MB, 31 * MB], { failLoadCall: 2 });
    await expect(runRitual(await baseOptions(), harness.deps)).rejects.toThrow("load failed");
    expect(harness.closed()).toBe(true);
  });

  it("rejects fewer than 3 cycles", async () => {
    harness = await makeHarness([]);
    await expect(
      runRitual({ ...(await baseOptions()), cycles: 2 }, harness.deps)
    ).rejects.toThrow("at least 3 cycles");
  });
});

// Most of a run's wall clock used to be a fixed sleep after every cycle. The
// idle period is methodologically required (transients must drain), but its
// duration is not: once the heap stops moving, waiting longer buys nothing.
describe("adaptive settle", () => {
  it("stops waiting once the heap stops moving", async () => {
    harness = await makeHarness([29 * MB, 31 * MB, 33 * MB, 35 * MB]);
    const options = { ...(await baseOptions()), idleMs: 60_000 };
    const started = Date.now();
    await runRitual(options, harness.deps);
    // The fake sleep is instant, so this asserts we never blocked on the full
    // idle budget: with a fixed wait the harness would have been asked to
    // sleep 60s per cycle.
    const sleeps = harness.events.filter((event) => event.startsWith("sleep:"));
    expect(sleeps.every((event) => Number(event.split(":")[1]) <= 2000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("records per-phase timings including settle", async () => {
    harness = await makeHarness([29 * MB, 31 * MB, 33 * MB, 35 * MB]);
    const result = await runRitual(await baseOptions(), harness.deps);
    const phases = result.timings.map((timing) => timing.phase);
    expect(phases).toContain("warm-up");
    expect(phases).toContain("baseline snapshot");
    expect(phases).toContain("cycle 1 settle");
    expect(phases).toContain("after snapshot");
    expect(result.timings.every((timing) => timing.seconds >= 0)).toBe(true);
  });
});
