import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runBuildMeasurement, type BuildRunDeps } from "./build-run.js";
import { parseProcessTable, type ProcessTableSample } from "./process-tree.js";

const MB = 1024 * 1024;
const BUILD_PID = 4242;
const WORKER_PID = 4243;
const WORKER_COMMAND = "/bin/node /repo/node_modules/next/dist/compiled/jest-worker/processChild.js";

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "next-leak-build-run-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { next: "16.3.1" }, scripts: { build: "next build" } })
  );
  return dir;
}

type FakeChild = EventEmitter & {
  pid: number;
  stdout: Readable;
  stderr: Readable;
  kill: (signal?: string) => boolean;
};

/**
 * A fake `next build`. It does not exit on its own: the scripted process table
 * ends it once every sample has been served, so the polling loop sees the whole
 * curve instead of racing the exit.
 */
function fakeChild(output: string): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = BUILD_PID;
  child.stdout = Readable.from([output]);
  child.stderr = Readable.from([]);
  child.kill = () => true;
  return child;
}

/**
 * Drives the run with a scripted process table: one row per poll, so the
 * worker's RSS follows `workerMb` exactly.
 */
function makeDeps(
  workerMb: number[],
  options: {
    output?: string;
    exitCode?: number | null;
    parentMb?: number[];
    noWorker?: boolean;
    onSignal?: (pid: number) => void;
    /** From this poll on, the worker pid is reported outside the build tree. */
    detachAfterPoll?: number;
  } = {}
): BuildRunDeps {
  let poll = 0;
  let clock = 0;
  let child: FakeChild | undefined;
  const exitCode = options.exitCode === undefined ? 0 : options.exitCode;
  return {
    spawnBuild: () => {
      child = fakeChild(options.output ?? "");
      return child as never;
    },
    signalWorker: (pid) => options.onSignal?.(pid),
    sampleTable: async (): Promise<ProcessTableSample> => {
      if (poll >= workerMb.length) {
        setImmediate(() => child?.emit("exit", exitCode));
        return { ok: true, rows: [] };
      }
      const workerRss = workerMb[poll] ?? 0;
      const parentRss = options.parentMb?.[Math.min(poll, (options.parentMb?.length ?? 1) - 1)] ?? 300;
      poll += 1;
      const parentRow = `${BUILD_PID} 1 ${parentRss * 1024} next-build\n`;
      // Pids get recycled: past `detachAfterPoll` the same number belongs to
      // something that is not the build's child any more.
      const detached =
        options.detachAfterPoll !== undefined && poll > options.detachAfterPoll;
      const workerRow = detached
        ? `${WORKER_PID} 1 ${workerRss * 1024} /usr/bin/unrelated\n`
        : `${WORKER_PID} ${BUILD_PID} ${workerRss * 1024} ${WORKER_COMMAND}\n`;
      return {
        ok: true,
        rows: parseProcessTable(
          options.noWorker === true ? parentRow : `${parentRow}${workerRow}`
        ),
      };
    },
    now: () => {
      clock += 500;
      return clock;
    },
    sleep: async () => {
      // Without a turn of the event loop the exit event never lands and the
      // polling loop would spin forever.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

describe("runBuildMeasurement", () => {
  it("calls a worker that climbs across the build a leak", async () => {
    // The 16.3.1 shape from the #97464 reproduction, in MB.
    const appDir = await makeProject();
    const result = await runBuildMeasurement(
      { appDir },
      makeDeps([1070, 1400, 1930, 2380, 2550, 2700, 2960, 2960])
    );

    expect(result.status).toBe("measured");
    expect(result.verdict).toBe("leak");
    expect(result.workers).toHaveLength(1);
  });

  it("calls the 16.2.12 control stable", async () => {
    const appDir = await makeProject();
    const result = await runBuildMeasurement(
      { appDir },
      makeDeps([428, 500, 512, 507, 524, 519, 529, 529])
    );

    expect(result.verdict).toBe("stable");
  });

  it("judges the worker, not the parent that sheds while it climbs", async () => {
    // Summing the tree would cancel the finding out: in the real run the
    // parent fell from 1.43 GB to 0.10 GB while the worker climbed.
    const appDir = await makeProject();
    const result = await runBuildMeasurement(
      { appDir },
      makeDeps([1070, 1400, 1930, 2380, 2550, 2700, 2960, 2960], {
        parentMb: [1430, 1200, 830, 500, 330, 200, 100, 100],
      })
    );

    expect(result.verdict).toBe("leak");
    expect(result.parentSamples.length).toBeGreaterThan(0);
  });

  it("reports a worker killed by the heap limit as the finding, not a failure", async () => {
    const appDir = await makeProject();
    const output = [
      "Generating static pages (1700/2504)",
      "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory",
      "⨯ Next.js build worker exited with code: null and signal: SIGABRT",
    ].join("\n");
    const result = await runBuildMeasurement(
      { appDir },
      makeDeps([1070, 1400, 1930, 2380, 2550, 2700, 2960, 2960], { output, exitCode: 1 })
    );

    expect(result.status).toBe("measured");
    expect(result.heapExhausted).toBe(true);
    expect(result.verdict).toBe("leak");
  });

  it("makes no memory claim when the build breaks for another reason", async () => {
    const appDir = await makeProject();
    const result = await runBuildMeasurement(
      { appDir },
      makeDeps([400, 400], { output: "Type error: Property 'x' does not exist", exitCode: 1 })
    );

    expect(result.status).toBe("build-failed");
    expect(result.verdict).toBeNull();
  });

  it("says there was nothing to measure when no worker ever ran", async () => {
    const appDir = await makeProject();
    const result = await runBuildMeasurement(
      { appDir },
      makeDeps([300, 300, 300], { noWorker: true })
    );

    expect(result.status).toBe("nothing-to-measure");
    expect(result.verdict).toBeNull();
    expect(result.parentSamples.length).toBeGreaterThan(0);
  });

  it("reports retention per page when the build says how far it got", async () => {
    const appDir = await makeProject();
    const result = await runBuildMeasurement(
      { appDir },
      makeDeps([1070, 1400, 1930, 2380, 2550, 2700, 2960, 2960], {
        output: "Generating static pages (1700/2504)",
      })
    );

    expect(result.pagesGenerated).toBe(1700);
    expect(result.retentionPerPageBytes).not.toBeNull();
    expect((result.retentionPerPageBytes ?? 0) / MB).toBeGreaterThan(0.5);
  });

  it("omits per-page retention when the build never said", async () => {
    const appDir = await makeProject();
    const result = await runBuildMeasurement(
      { appDir },
      makeDeps([1070, 1400, 1930, 2380, 2550, 2700, 2960, 2960])
    );

    expect(result.pagesGenerated).toBeNull();
    expect(result.retentionPerPageBytes).toBeNull();
  });

  it("warns about a heap cap Next strips before the worker sees it", async () => {
    const appDir = await makeProject();
    const messages: string[] = [];
    const result = await runBuildMeasurement(
      {
        appDir,
        env: { NODE_OPTIONS: "--max-old-space-size=2048" },
        onProgress: (message) => messages.push(message),
      },
      makeDeps([400, 420, 410, 430, 425, 440, 435, 435])
    );

    expect(result.strippedCapWarning).toContain("--max-heap-size=2048");
    expect(messages.some((message) => message.includes("never sees it"))).toBe(true);
  });

  it("keeps the peak the worker reached", async () => {
    const appDir = await makeProject();
    const result = await runBuildMeasurement(
      { appDir },
      makeDeps([1070, 1400, 1930, 2380, 2550, 2700, 2960, 2960])
    );

    expect(result.peakWorkerRssBytes).toBe(2960 * MB);
  });

  it("refuses a project that is not a Next.js app before spawning anything", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "next-leak-build-run-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: {} }));

    await expect(
      runBuildMeasurement({ appDir: dir }, makeDeps([100, 200]))
    ).rejects.toThrow(/not a Next\.js project/);
  });
});

describe("runBuildMeasurement when the process table is unreadable", () => {
  it("reports that it could not look instead of finding nothing", async () => {
    // Seen for real: a sandbox denying `ps` turned a leaking build into a
    // clean "nothing to measure" run.
    const appDir = await makeProject();
    const deps = makeDeps([400, 400, 400]);
    let child: { emit: (event: string, code: number) => void } | undefined;
    const result = await runBuildMeasurement(
      { appDir },
      {
        ...deps,
        spawnBuild: (...args) => {
          const spawned = deps.spawnBuild(...args);
          child = spawned as unknown as typeof child;
          return spawned;
        },
        sampleTable: async () => {
          // The build itself carries on and finishes; only the sampling died.
          setImmediate(() => child?.emit("exit", 0));
          return { ok: false, reason: "spawn ps EPERM" };
        },
      }
    );

    expect(result.status).toBe("cannot-sample");
    expect(result.samplingFailure).toBe("spawn ps EPERM");
    expect(result.verdict).toBeNull();
  });
});

// A build that ran out of heap is not a curve to be interpreted. Measured on
// the real #97464 repro: the worker died at 1758 MB after 1252 pages, and the
// segmented curve read `stable` because one segment gave 79 MB back.
describe("runBuildMeasurement when the worker runs out of heap", () => {
  it("calls it a leak even when the curve oscillates enough to look stable", async () => {
    const appDir = await makeProject();
    const output = [
      "Generating static pages (1252/2504)",
      "FATAL ERROR: JavaScript heap out of memory",
    ].join("\n");
    const result = await runBuildMeasurement(
      { appDir },
      makeDeps([1252, 1135, 1255, 1732, 1654, 1685, 1758, 1758], { output, exitCode: 1 })
    );

    expect(result.heapExhausted).toBe(true);
    expect(result.verdict).toBe("leak");
    // The measured trend is still reported as it was read: the override is a
    // statement about the outcome, not a rewrite of the evidence.
    expect(result.trend?.verdict).toBe("stable");
  });
});

describe("per-page retention when the build crashed", () => {
  it("reports no per-page figure, because the curve is truncated", async () => {
    // Measured against the real reproduction: the segmented curve ends below
    // where it started, and using the worker's first raw reading as the base
    // folds module loading into the numerator — that gave 1.59 MB/page against
    // the ~0.9 the issue measures. How far it got and what it reached are the
    // facts; a denominator here would be guesswork.
    const appDir = await makeProject();
    const output = ["Generating static pages (1252/2504)", "FATAL ERROR: JavaScript heap out of memory"].join("\n");
    const result = await runBuildMeasurement(
      { appDir },
      makeDeps([1381, 1974, 2245, 2479, 1552, 1533, 1688, 1688], { output, exitCode: 1 })
    );

    expect(result.verdict).toBe("leak");
    expect(result.pagesGenerated).toBe(1252);
    expect(result.peakWorkerRssBytes).toBe(2479 * MB);
    expect(result.retentionPerPageBytes).toBeNull();
  });
});

// Capture is an addition to the report. Every one of these asserts that the
// verdict and the curve survive a capture that did not work out.
describe("runBuildMeasurement capture", () => {
  it("does not signal at all when no work directory was given", async () => {
    const signalled: number[] = [];
    const result = await runBuildMeasurement(
      { appDir: await makeProject() },
      makeDeps([200, 400, 700], { onSignal: (pid) => signalled.push(pid) })
    );

    expect(signalled).toEqual([]);
    expect(result.capture).toBeNull();
    expect(result.status).toBe("measured");
  });

  it("still reports a verdict when the worker dies before the second snapshot", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "next-leak-capture-"));
    const signalled: number[] = [];
    const result = await runBuildMeasurement(
      { appDir: await makeProject(), workDir },
      makeDeps([200, 260], {
        output: "JavaScript heap out of memory",
        exitCode: 1,
        onSignal: (pid) => signalled.push(pid),
      })
    );

    // The baseline was taken and the worker never grew enough for a second.
    expect(signalled).toEqual([WORKER_PID]);
    expect(result.capture).toBeNull();
    expect(result.verdict).toBe("leak");
    expect(result.heapExhausted).toBe(true);
  });

  it("signals twice once the worker reaches the capture target", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "next-leak-capture-"));
    const signalled: number[] = [];
    await runBuildMeasurement(
      { appDir: await makeProject(), workDir },
      makeDeps([200, 400, 1000], { onSignal: (pid) => signalled.push(pid) })
    );

    expect(signalled).toEqual([WORKER_PID, WORKER_PID]);
  });

  // A remembered pid looked up across the whole process table would follow a
  // stranger, and this code signals what it finds — SIGUSR2 with no handler
  // kills a process.
  it("stops following a pid once it leaves the build tree", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "next-leak-capture-"));
    const signalled: number[] = [];
    await runBuildMeasurement(
      { appDir: await makeProject(), workDir },
      makeDeps([200, 1000, 1000], {
        detachAfterPoll: 1,
        onSignal: (pid) => signalled.push(pid),
      })
    );

    // Only the baseline, taken while the pid really was the build's worker.
    expect(signalled).toEqual([WORKER_PID]);
  });

  it("never signals a worker already past the parse limit", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "next-leak-capture-"));
    const signalled: number[] = [];
    await runBuildMeasurement(
      { appDir: await makeProject(), workDir },
      makeDeps([2000, 2600, 3000], { onSignal: (pid) => signalled.push(pid) })
    );

    // A snapshot up there is written, costs the disk, and cannot be read back.
    expect(signalled).toEqual([]);
  });
});
