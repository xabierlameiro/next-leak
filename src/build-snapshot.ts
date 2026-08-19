import { readdir, rename } from "node:fs/promises";
import path from "node:path";

/**
 * Worker resident memory above which its heap snapshot stops being parseable.
 *
 * Measured on 2026-08-19 against the vercel/next.js#97464 reproduction, three
 * points: a worker at 802 MB wrote 310 MB, at 1201 MB wrote 563 MB, and at
 * 3010 MB wrote 2388 MB. The ratio is not flat — 0.39x, 0.47x, 0.79x — so the
 * 512 MB a V8 string can hold is crossed somewhere just past 1 GB of RSS.
 * A snapshot taken above this is written, costs the disk, and then cannot be
 * read (see `assertReadableSnapshot`), which is the worst of both.
 */
export const PARSEABLE_WORKER_RSS_BYTES = 1024 * 1024 * 1024;

/**
 * Resident memory below which a worker has not finished loading its own
 * module graph. A baseline taken there would diff mostly Next booting up.
 */
const START_UP_FLOOR_BYTES = 128 * 1024 * 1024;

/**
 * Growth a pair must bracket to be worth diffing at all. Below this the diff
 * reports start-up noise dressed as a finding.
 */
const MIN_PAIR_GROWTH_BYTES = 128 * 1024 * 1024;

/**
 * Where the second capture aims.
 *
 * An earlier version fired it as soon as the worker had grown past
 * `MIN_PAIR_GROWTH_BYTES`, which on the #97464 reproduction meant snapshots at
 * 276 MB and 597 MB — both before the worker reached its first sampled level
 * of 1637 MB. The diff duly reported 1 MB of `Immediate` objects: the run had
 * measured the worker booting, not generating pages. The second capture has to
 * be as late as the parse limit allows, not as early as the growth floor
 * permits.
 */
const AFTER_TARGET_RSS_BYTES = Math.floor(PARSEABLE_WORKER_RSS_BYTES * 0.9);

export type CaptureStage = "waiting" | "baseline-taken" | "pair-taken" | "missed";

export type CaptureDecision = "wait" | "take-baseline" | "take-after" | "give-up";

/**
 * Decides what to do with a worker at this resident size.
 *
 * Both snapshots have to happen low on the curve, which is not where the
 * interesting memory is. That is forced by the parse limit above and is the
 * central compromise of build-time attribution: the pair samples the start of
 * the growth rather than bracketing it, so the report has to say how much of
 * the curve it actually covers.
 */
export function decideCapture(
  rssBytes: number,
  stage: CaptureStage,
  baselineRssBytes: number | null
): CaptureDecision {
  if (stage === "pair-taken" || stage === "missed") {
    return "wait";
  }
  if (stage === "waiting") {
    if (rssBytes > PARSEABLE_WORKER_RSS_BYTES) {
      // The worker was already past the limit the first time it was seen, so
      // there is no pair to be had. Saying so beats writing files nobody can
      // read.
      return "give-up";
    }
    return rssBytes >= START_UP_FLOOR_BYTES ? "take-baseline" : "wait";
  }
  const baseline = baselineRssBytes ?? 0;
  const grown = rssBytes - baseline;
  if (rssBytes > PARSEABLE_WORKER_RSS_BYTES) {
    // Last chance: the worker jumped from below the target to past the limit
    // between two polls. A snapshot at the edge beats no pair at all, provided
    // the pair spans enough to be about the workload rather than start-up.
    return grown >= MIN_PAIR_GROWTH_BYTES ? "take-after" : "give-up";
  }
  if (rssBytes < AFTER_TARGET_RSS_BYTES) {
    return "wait";
  }
  return grown >= MIN_PAIR_GROWTH_BYTES ? "take-after" : "wait";
}

/**
 * V8 writes `--heapsnapshot-signal` output to the process cwd, which for a
 * static-generation worker is the user's project, under a name carrying the
 * date, the time, the pid and a sequence number:
 * `Heap.20260819.013329.17770.0.001.heapsnapshot`. The pid is what keeps two
 * workers from overwriting each other; the sequence orders one worker's own
 * captures.
 */
const SNAPSHOT_NAME = /^Heap\.\d{8}\.\d{6}\.(\d+)\.\d+\.(\d+)\.heapsnapshot$/;

export function snapshotsWrittenBy(pid: number, filenames: readonly string[]): string[] {
  return filenames
    .filter((name) => {
      const match = SNAPSHOT_NAME.exec(name);
      return match !== null && Number(match[1]) === pid;
    })
    .sort();
}

export type CollectedPair = {
  baselineFile: string;
  afterFile: string;
};

/**
 * Moves a worker's two snapshots out of the project and into the run's own
 * directory. They are the user's source tree's problem otherwise: V8 chose
 * where to put them, and leaving half a gigabyte of them behind in a repo
 * would be a poor trade for a measurement.
 */
export async function collectSnapshotPair(
  appDir: string,
  outDir: string,
  pid: number
): Promise<CollectedPair | null> {
  let entries: string[];
  try {
    entries = await readdir(appDir);
  } catch {
    return null;
  }
  const written = snapshotsWrittenBy(pid, entries);
  const [baseline, after] = written;
  if (baseline === undefined || after === undefined) {
    return null;
  }
  const baselineFile = path.join(outDir, `worker-${pid}-baseline.heapsnapshot`);
  const afterFile = path.join(outDir, `worker-${pid}-after.heapsnapshot`);
  try {
    await rename(path.join(appDir, baseline), baselineFile);
    await rename(path.join(appDir, after), afterFile);
  } catch {
    return null;
  }
  return { baselineFile, afterFile };
}

/**
 * Deletes snapshots a run wrote and cannot use — a give-up after the baseline,
 * or a worker whose pair never completed. Without this a failed capture leaves
 * hundreds of megabytes in the user's project with no report referring to them.
 */
export async function discardSnapshots(appDir: string, pid: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(appDir);
  } catch {
    return;
  }
  const { unlink } = await import("node:fs/promises");
  for (const name of snapshotsWrittenBy(pid, entries)) {
    try {
      await unlink(path.join(appDir, name));
    } catch {
      // A file that cannot be removed is not worth failing a measurement over.
    }
  }
}

/**
 * What share of the worker's observed growth the pair actually spans.
 *
 * Reported rather than hidden because the parse limit forces the pair low: on
 * the #97464 reproduction the worker peaks near 3.3 GB and the pair cannot
 * reach past 1 GB, so the attributed bytes explain a minority of the curve. A
 * reader comparing the two numbers without this would conclude the rest went
 * unexplained.
 */
export function bracketedShare(
  baselineRssBytes: number,
  afterRssBytes: number,
  peakRssBytes: number
): number {
  const total = peakRssBytes - baselineRssBytes;
  if (total <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, (afterRssBytes - baselineRssBytes) / total));
}
