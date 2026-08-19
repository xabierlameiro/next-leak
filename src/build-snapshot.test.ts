import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bracketedShare,
  collectSnapshotPair,
  decideCapture,
  discardSnapshots,
  snapshotsWrittenBy,
  PARSEABLE_WORKER_RSS_BYTES,
} from "./build-snapshot.js";

const MB = 1024 * 1024;

const tempDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), "next-leak-snap-"));

// The capture window is not a preference, it is what the parse limit leaves:
// measured on the #97464 repro, a worker past ~1 GB writes a snapshot bigger
// than a V8 string can hold, so both captures have to happen below it.
describe("decideCapture", () => {
  it("waits until the worker has loaded its own module graph", () => {
    expect(decideCapture(40 * MB, "waiting", null)).toBe("wait");
    expect(decideCapture(200 * MB, "waiting", null)).toBe("take-baseline");
  });

  it("gives up on a worker first seen above the parse limit", () => {
    expect(decideCapture(PARSEABLE_WORKER_RSS_BYTES + 1, "waiting", null)).toBe("give-up");
  });

  // The second capture aims as late as the parse limit allows. Firing it at
  // the growth floor instead put both snapshots below the worker's first
  // sampled level on the #97464 repro, and the diff reported the worker
  // booting rather than generating pages.
  it("waits for the target rather than firing at the growth floor", () => {
    expect(decideCapture(340 * MB, "baseline-taken", 200 * MB)).toBe("wait");
    expect(decideCapture(PARSEABLE_WORKER_RSS_BYTES, "baseline-taken", 200 * MB)).toBe(
      "take-after"
    );
  });

  it("does not fire at the target when the pair would span too little", () => {
    const nearLimit = PARSEABLE_WORKER_RSS_BYTES - 1;
    expect(decideCapture(nearLimit, "baseline-taken", nearLimit - 1 * MB)).toBe("wait");
  });

  it("still takes the second when the worker jumped past the limit", () => {
    // Better a snapshot at the edge than no pair at all: the alternative is a
    // build that grew 900 MB between two polls and reports nothing.
    expect(decideCapture(PARSEABLE_WORKER_RSS_BYTES + 1, "baseline-taken", 200 * MB)).toBe(
      "take-after"
    );
  });

  it("gives up when the worker passed the limit without growing enough", () => {
    expect(
      decideCapture(PARSEABLE_WORKER_RSS_BYTES + 1, "baseline-taken", PARSEABLE_WORKER_RSS_BYTES)
    ).toBe("give-up");
  });

  it("does nothing more once the pair is taken", () => {
    expect(decideCapture(3000 * MB, "pair-taken", 200 * MB)).toBe("wait");
    expect(decideCapture(3000 * MB, "missed", null)).toBe("wait");
  });
});

// V8 names the file after the pid, which is the only thing keeping two workers
// of the same build from overwriting each other.
describe("snapshotsWrittenBy", () => {
  const names = [
    "Heap.20260819.013329.17770.0.001.heapsnapshot",
    "Heap.20260819.013512.17770.0.002.heapsnapshot",
    "Heap.20260819.013400.99999.0.001.heapsnapshot",
    "notes.md",
  ];

  it("matches only the given worker, in capture order", () => {
    expect(snapshotsWrittenBy(17770, names)).toEqual([
      "Heap.20260819.013329.17770.0.001.heapsnapshot",
      "Heap.20260819.013512.17770.0.002.heapsnapshot",
    ]);
  });

  it("does not confuse one worker for another", () => {
    expect(snapshotsWrittenBy(99999, names)).toEqual([
      "Heap.20260819.013400.99999.0.001.heapsnapshot",
    ]);
    expect(snapshotsWrittenBy(1234, names)).toEqual([]);
  });
});

describe("collectSnapshotPair", () => {
  it("moves both files out of the project", async () => {
    const appDir = await tempDir();
    const outDir = await tempDir();
    await writeFile(path.join(appDir, "Heap.20260819.013329.500.0.001.heapsnapshot"), "a");
    await writeFile(path.join(appDir, "Heap.20260819.013512.500.0.002.heapsnapshot"), "b");

    const pair = await collectSnapshotPair(appDir, outDir, 500);

    expect(pair).not.toBeNull();
    expect(path.basename(pair?.baselineFile ?? "")).toBe("worker-500-baseline.heapsnapshot");
    // Nothing of ours is left behind in the user's source tree.
    expect((await readdir(appDir)).filter((n) => n.endsWith(".heapsnapshot"))).toEqual([]);
    expect((await readdir(outDir)).sort()).toEqual([
      "worker-500-after.heapsnapshot",
      "worker-500-baseline.heapsnapshot",
    ]);
  });

  it("returns null when only one snapshot ever landed", async () => {
    const appDir = await tempDir();
    const outDir = await tempDir();
    await writeFile(path.join(appDir, "Heap.20260819.013329.500.0.001.heapsnapshot"), "a");

    expect(await collectSnapshotPair(appDir, outDir, 500)).toBeNull();
  });
});

describe("discardSnapshots", () => {
  it("removes what a failed capture left in the project", async () => {
    const appDir = await tempDir();
    await writeFile(path.join(appDir, "Heap.20260819.013329.500.0.001.heapsnapshot"), "a");
    await writeFile(path.join(appDir, "keep.txt"), "keep");

    await discardSnapshots(appDir, 500);

    expect((await readdir(appDir)).sort()).toEqual(["keep.txt"]);
  });
});

// The share is what stops a reader treating the attributed bytes as the whole
// curve, so it has to be honest at both ends.
describe("bracketedShare", () => {
  it("reports the fraction of observed growth the pair spans", () => {
    expect(bracketedShare(200 * MB, 1000 * MB, 3400 * MB)).toBeCloseTo(0.25, 2);
  });

  it("never exceeds one or falls below zero", () => {
    expect(bracketedShare(200 * MB, 3400 * MB, 3400 * MB)).toBe(1);
    expect(bracketedShare(200 * MB, 100 * MB, 3400 * MB)).toBe(0);
  });

  it("treats a flat worker as fully bracketed rather than dividing by zero", () => {
    expect(bracketedShare(200 * MB, 200 * MB, 200 * MB)).toBe(1);
  });
});
