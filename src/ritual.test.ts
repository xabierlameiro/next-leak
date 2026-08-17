import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestMemory } from "./control-client.js";
import type { LaunchedApp } from "./launcher.js";
import type { LoadPhaseResult } from "./load.js";
import { runRitual, unreclaimedSettleFor, type RitualDeps } from "./ritual.js";

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
  options: {
    failLoadCall?: number;
    underLoadHeap?: number;
    failMemory?: boolean;
    /** Per-poll /gc readings; overrides the per-cycle script when present. */
    gcPollScript?: number[];
  } = {}
): Promise<Harness> {
  const events: string[] = [];
  // The heap value advances once per load cycle, so settle probes and the
  // cycle sample observe the same value — as they do against a real process.
  let cycleIndex = 0;
  let closed = false;
  let loadCalls = 0;
  let gcPolls = 0;
  let memPolls = 0;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://control.local");
    const heapUsed = heapScript[Math.min(cycleIndex, heapScript.length - 1)] ?? 0;
    const sample = { gcExposed: true, heapUsed, rss: 1, external: 1, arrayBuffers: 1 };
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/gc") {
      events.push("gc");
      if (options.gcPollScript !== undefined) {
        const scripted = options.gcPollScript[Math.min(gcPolls, options.gcPollScript.length - 1)] ?? 0;
        gcPolls += 1;
        response.end(JSON.stringify({ ...sample, heapUsed: scripted }));
        return;
      }
      response.end(JSON.stringify(sample));
      return;
    }
    if (url.pathname === "/mem") {
      events.push("mem");
      if (options.failMemory === true) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "gone" }));
        return;
      }
      // A process under load reads higher than it does after idle and GC —
      // and each class must be distinguishable, or a poller that keeps the
      // MINIMUM of rss/external/arrayBuffers looks identical to one keeping
      // the maximum (mutation testing caught exactly that surviving).
      memPolls += 1;
      response.end(
        JSON.stringify({
          ...sample,
          heapUsed: options.underLoadHeap ?? heapUsed,
          external: memPolls * MB,
          arrayBuffers: 2 * memPolls * MB,
          rss: 10 * memPolls * MB,
        })
      );
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
    explainExit: () => null,
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
    abandon: async ({ amount }) => {
      events.push(`abandon:${amount}`);
      cycleIndex += 1;
      return { sent: amount, abandoned: amount, abandonedMidStream: amount, abandonedBeforeResponse: 0, completed: 0, errors: 0 };
    },
    readMemory: requestMemory,
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
    harness = await makeHarness([29 * MB, 31 * MB, 33 * MB, 35 * MB, 37 * MB]);
    const result = await runRitual(await baseOptions(), harness.deps);

    // The methodology, not the implementation: warm-up before the baseline,
    // and every sample preceded by load then a settle period with GC.
    const shape = harness.events.filter((event) => !event.startsWith("sleep:"));
    expect(shape[0]).toBe("load:200");
    expect(shape[1]).toBe("snapshot:baseline");
    expect(shape.filter((event) => event === "load:5000")).toHaveLength(4);
    expect(shape.at(-1)).toBe("snapshot:after");
    // Every cycle's sample is preceded by a forced collection: a `gc` for the
    // intermediate cycles, the after-snapshot for the last one. Asserted over
    // the whole span to the next load rather than a fixed-width window, so
    // adding a phase inside the cycle cannot silently void the check.
    for (const [index, event] of shape.entries()) {
      if (event !== "load:5000") {
        continue;
      }
      const nextLoad = shape.findIndex((later, at) => at > index && later === "load:5000");
      const cycle = shape.slice(index + 1, nextLoad === -1 ? undefined : nextLoad);
      expect(cycle.some((phase) => phase === "gc" || phase === "snapshot:after")).toBe(true);
    }
    expect(result.samples).toEqual([29 * MB, 31 * MB, 33 * MB, 35 * MB, 37 * MB]);
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

// The options each phase receives ARE the measurement: a run that silently
// drops `headers` measures a code path no browser executes, one that drops
// `maxOldSpaceMb` runs the child under the wrong cap, and one that loses
// `abandonAfterMs` never touches the disconnect path at all. Phase-0 shipped
// two abandon implementations that failed exactly this silently — mutation
// testing showed the pass-through was still unasserted.
describe("option pass-through", () => {
  it("hands every knob to the phases that consume it", async () => {
    const launches: unknown[] = [];
    const loads: unknown[] = [];
    harness = await makeHarness([29 * MB, 30 * MB, 30 * MB, 30 * MB]);
    const deps: RitualDeps = {
      ...harness.deps,
      launch: async (options) => {
        launches.push(options);
        return harness!.deps.launch(options);
      },
      load: async (options) => {
        loads.push(options);
        return harness!.deps.load(options);
      },
    };

    await runRitual(
      {
        ...(await baseOptions()),
        connections: 7,
        warmupRequests: 200,
        loadRequests: 5000,
        maxOldSpaceMb: 2048,
        headers: { "accept-encoding": "gzip" },
      },
      deps
    );

    const launch = launches[0] as { maxOldSpaceMb?: number };
    expect(launch.maxOldSpaceMb).toBe(2048);

    const [warmup, ...cycles] = loads as Array<{
      amount: number;
      connections: number;
      headers?: Record<string, string>;
      url: string;
    }>;
    // Warm-up: its own request count and low concurrency, same headers.
    expect(warmup?.amount).toBe(200);
    expect(warmup?.connections).toBe(10);
    expect(warmup?.headers).toEqual({ "accept-encoding": "gzip" });
    expect(warmup?.url).toContain("/leaky");
    // Every load cycle: the requested traffic, concurrency and headers.
    expect(cycles.length).toBeGreaterThan(0);
    for (const cycle of cycles) {
      expect(cycle.amount).toBe(5000);
      expect(cycle.connections).toBe(7);
      expect(cycle.headers).toEqual({ "accept-encoding": "gzip" });
      expect(cycle.url).toContain("/leaky");
    }
  });

  it("routes cycles through the abandon phase with every knob intact", async () => {
    const abandons: unknown[] = [];
    harness = await makeHarness([29 * MB, 30 * MB, 30 * MB, 30 * MB]);
    const deps: RitualDeps = {
      ...harness.deps,
      abandon: async (options) => {
        abandons.push(options);
        return harness!.deps.abandon(options);
      },
    };

    const result = await runRitual(
      {
        ...(await baseOptions()),
        connections: 9,
        loadRequests: 1234,
        abandonAfterMs: 4,
        headers: { "accept-encoding": "br" },
      },
      deps
    );

    // Warm-up must NOT go through the abandon path: the baseline needs a
    // normally-served app, not one mid-teardown.
    expect(abandons.length).toBeGreaterThan(0);
    for (const phase of abandons as Array<{
      amount: number;
      connections: number;
      abandonAfterMs: number;
      headers?: Record<string, string>;
      url: string;
    }>) {
      expect(phase.url).toContain("/leaky");
      expect(phase.amount).toBe(1234);
      expect(phase.connections).toBe(9);
      expect(phase.abandonAfterMs).toBe(4);
      expect(phase.headers).toEqual({ "accept-encoding": "br" });
    }
    // The outcome lands in the audit trail with the mid-stream count intact.
    const outcome = result.loadOutcomes.find((entry) => entry.phase === "cycle 1");
    expect(outcome?.abandoned).toBe(1234);
    expect(outcome?.abandonedMidStream).toBe(1234);
  });

  it("omits headers entirely when none are configured", async () => {
    const loads: Array<{ headers?: unknown }> = [];
    harness = await makeHarness([29 * MB, 30 * MB, 30 * MB, 30 * MB]);
    const deps: RitualDeps = {
      ...harness.deps,
      load: async (options) => {
        loads.push(options as { headers?: unknown });
        return harness!.deps.load(options);
      },
    };
    await runRitual(await baseOptions(), deps);
    expect(loads.every((options) => !("headers" in options))).toBe(true);
  });
});

// The settle loop's tolerance decides when a sample is trustworthy; its
// boundary is load-bearing (±1% of the previous reading).
describe("settle tolerance boundary", () => {
  const settleScript = async (values: number[]): Promise<string[]> => {
    harness = await makeHarness(values);
    const result = await runRitual({ ...(await baseOptions()), idleMs: 60_000 }, harness.deps);
    return result.settleOutcomes.map((outcome) => outcome.status);
  };

  it("treats movement within 1% as settled", async () => {
    // Consecutive polls read the same scripted value per cycle, so the heap
    // is exactly still — the settled branch must be reachable.
    const statuses = await settleScript([29 * MB, 30 * MB, 30 * MB, 30 * MB]);
    expect(statuses.every((status) => status === "settled")).toBe(true);
  });
});

// A verdict is about what a process retains. What kills it in a container is
// what it reaches. Those are different numbers and the run must report both.
describe("peak capture", () => {
  it("records the highest memory seen during each cycle", async () => {
    harness = await makeHarness([29 * MB, 30 * MB, 30 * MB, 30 * MB], {
      underLoadHeap: 900 * MB,
    });
    const result = await runRitual(await baseOptions(), harness.deps);

    expect(result.peaks).toHaveLength(4);
    expect(result.peaks.map((peak) => peak.phase)).toEqual([
      "cycle 1",
      "cycle 2",
      "cycle 3",
      "cycle 4",
    ]);
    expect(result.peaks.every((peak) => peak.heapUsed === 900 * MB)).toBe(true);
    expect(result.peaks.every((peak) => peak.polls > 0)).toBe(true);
  });

  it("leaves the verdict to the post-GC samples", async () => {
    // The shape a container kills and a retention verdict calls healthy:
    // enormous under load, flat once the load stops.
    harness = await makeHarness([29 * MB, 30 * MB, 30.1 * MB, 30 * MB], {
      underLoadHeap: 3500 * MB,
    });
    const result = await runRitual(await baseOptions(), harness.deps);

    expect(result.trend.verdict).toBe("stable");
    expect(result.samples).toEqual([29 * MB, 30 * MB, 30.1 * MB, 30 * MB, 30 * MB]);
    expect(result.peaks[0]?.heapUsed).toBe(3500 * MB);
  });

  it("does not poll the warm-up phase", async () => {
    harness = await makeHarness([29 * MB, 31 * MB, 33 * MB, 35 * MB]);
    await runRitual(await baseOptions(), harness.deps);

    const firstMem = harness.events.indexOf("mem");
    const baseline = harness.events.indexOf("snapshot:baseline");
    expect(firstMem).toBeGreaterThan(baseline);
  });

  it("survives a control channel that stops answering", async () => {
    harness = await makeHarness([29 * MB, 31 * MB, 33 * MB, 35 * MB], {
      failMemory: true,
    });
    const result = await runRitual(await baseOptions(), harness.deps);

    // A poll that fails is not a cycle that fails: the verdict still lands and
    // the empty peak says plainly that nothing was read.
    expect(result.trend.verdict).toBe("leak");
    expect(result.peaks.every((peak) => peak.polls === 0)).toBe(true);
  });
});

// Killed mutants, each a real failure mode the suite previously accepted.
describe("mutation-hardening: ritual", () => {
  it("keeps the MAXIMUM of every memory class in a peak, not the minimum", async () => {
    // The harness's /mem grows every class monotonically per poll, so a
    // poller keeping minimums would report the first reading, not the last.
    harness = await makeHarness([29 * MB, 30 * MB, 30 * MB, 30 * MB]);
    const result = await runRitual(await baseOptions(), harness.deps);
    // The /mem counter is global across cycles, so by the last cycle a
    // max-keeping poller must read strictly above the first poll's values —
    // while a min-keeping one would still be stuck at them.
    const last = result.peaks.at(-1);
    expect(last).toBeDefined();
    expect(last!.external).toBeGreaterThan(1 * MB);
    expect(last!.arrayBuffers).toBeGreaterThan(last!.external);
    expect(last!.rss).toBeGreaterThan(last!.arrayBuffers);
  });

  it("reports a heap that never stops moving as `moving`, not settled", async () => {
    // Every /gc poll reads 10% below the previous one: outside the 1%
    // tolerance forever. A mutant that widens the tolerance (or inverts the
    // comparison) turns this into `settled` and the audit loses its warning.
    const falling = Array.from({ length: 40 }, (_, index) => (300 - index * 30) * MB);
    harness = await makeHarness([29 * MB, 30 * MB, 30 * MB, 30 * MB], {
      gcPollScript: falling,
    });
    const result = await runRitual({ ...(await baseOptions()), idleMs: 20 }, harness.deps);
    expect(result.settleOutcomes.some((outcome) => outcome.status === "moving")).toBe(true);
  });

  it("accepts exactly 3 cycles, the documented minimum", async () => {
    harness = await makeHarness([29 * MB, 30 * MB, 30 * MB, 30 * MB]);
    const result = await runRitual({ ...(await baseOptions()), cycles: 3 }, harness.deps);
    expect(result.samples).toHaveLength(4);
  });

  it("hands the regime gate to the trend classifier", async () => {
    // 0.5 MB/cycle growth: a leak against the default floor (256 KiB), noise
    // against the gate a 50k-requests cycle earns. Dropping the third argument
    // to classifyMemoryTrend silently re-judges every big run at the floor.
    const creeping = [29 * MB, 30 * MB, 30.5 * MB, 31 * MB, 31.5 * MB];
    harness = await makeHarness(creeping);
    const result = await runRitual(
      { ...(await baseOptions()), loadRequests: 50_000, cycles: 4 },
      harness.deps
    );
    expect(result.minGrowthPerCycle).toBeGreaterThan(1 * MB);
    expect(result.trend.verdict).toBe("stable");
  });

  it("surfaces the child's own death instead of the downstream fetch error", async () => {
    harness = await makeHarness([29 * MB, 31 * MB], { failLoadCall: 2 });
    const explained = {
      ...harness.deps,
      launch: async (options: Parameters<RitualDeps["launch"]>[0]) => {
        const app = await harness!.deps.launch(options);
        return { ...app, explainExit: () => "the measured process ran out of heap (limit 512 MB)" };
      },
    };
    await expect(runRitual(await baseOptions(), explained)).rejects.toThrow(
      /ran out of heap \(limit 512 MB\)/
    );
  });

  it("labels every phase in timings and settle outcomes", async () => {
    harness = await makeHarness([29 * MB, 30 * MB, 30 * MB, 30 * MB]);
    const result = await runRitual({ ...(await baseOptions()), cycles: 3 }, harness.deps);
    const phases = result.timings.map((timing) => timing.phase);
    expect(phases).toEqual([
      "warm-up",
      "baseline snapshot",
      "cycle 1 load",
      "cycle 1 unreclaimed read",
      "cycle 1 settle",
      "cycle 2 load",
      "cycle 2 unreclaimed read",
      "cycle 2 settle",
      "cycle 3 load",
      "cycle 3 unreclaimed read",
      "cycle 3 settle",
      "after snapshot",
    ]);
    expect(result.settleOutcomes.map((outcome) => outcome.phase)).toEqual([
      "cycle 1",
      "cycle 2",
      "cycle 3",
    ]);
  });
});

// Every other number in a run is post-GC, which is what makes the verdict
// mean something and is also blind to memory a full GC would reclaim that a
// production process never runs one often enough to (vercel/next.js#96533).
describe("unreclaimed retention", () => {
  it("caps the pre-collection wait at a quarter of the idle", () => {
    // --quick idles for 8s: a flat 2s wait would be a quarter of its budget,
    // and anything shorter must scale down rather than eat the settle.
    expect(unreclaimedSettleFor(30_000)).toBe(2000);
    expect(unreclaimedSettleFor(8000)).toBe(2000);
    expect(unreclaimedSettleFor(4000)).toBe(1000);
    expect(unreclaimedSettleFor(0)).toBe(0);
  });

  it("records one pre-collection reading per cycle", async () => {
    harness = await makeHarness([29 * MB, 30 * MB, 31 * MB, 32 * MB]);
    const result = await runRitual({ ...(await baseOptions()), cycles: 3 }, harness.deps);

    expect(result.unreclaimedSamples).toHaveLength(3);
    expect(result.samples).toHaveLength(4); // baseline + 3 cycles, unchanged
  });

  it("waits idle/4 before the reading and hands the rest to the settle", async () => {
    harness = await makeHarness([29 * MB, 30 * MB, 31 * MB, 32 * MB]);
    await runRitual({ ...(await baseOptions()), cycles: 3, idleMs: 4000 }, harness.deps);

    // Sleeps here are fake and instant, so their sum is not wall clock and
    // cannot show the total idle. What it does show is the shape: each cycle
    // opens its idle with the 1000 ms pre-collection wait (4000 / 4) before
    // the first `mem`, and the settle that follows never blocks longer than
    // one poll.
    const idle = harness.events.filter(
      (event) => event === "mem" || event === "gc" || event.startsWith("sleep:")
    );
    const firstCycle = idle.slice(idle.indexOf("sleep:1000"));

    expect(firstCycle[0]).toBe("sleep:1000");
    expect(firstCycle[1]).toBe("mem");
    expect(
      idle
        .filter((event) => event.startsWith("sleep:"))
        .map((event) => Number(event.split(":")[1]))
        .every((ms) => ms <= 2000)
    ).toBe(true);
  });

  it("drops the whole series when a reading is lost", async () => {
    // A hole makes every later delta span two cycles instead of one, so a
    // partial series is worse than none. The verdict must survive it.
    harness = await makeHarness([29 * MB, 30 * MB, 31 * MB, 32 * MB], { failMemory: true });
    const result = await runRitual({ ...(await baseOptions()), cycles: 3 }, harness.deps);

    expect(result.unreclaimedSamples).toEqual([]);
    expect(result.unreclaimedTrend.verdict).toBe("inconclusive");
    expect(result.samples).toHaveLength(4);
    expect(result.trend.verdict).toBeDefined();
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
