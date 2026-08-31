import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { z } from "zod";
import type { HeapSample } from "./control-server.js";

const sampleSchema = z.object({
  gcExposed: z.boolean(),
  heapUsed: z.number(),
  rss: z.number(),
  external: z.number(),
  arrayBuffers: z.number(),
});

const snapshotResponseSchema = z.object({ file: z.string(), sample: sampleSchema });

class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}

/**
 * How long each operation may take, wall-clock — owned here instead of
 * inherited from an HTTP client.
 *
 * `fetch` rode on undici's implicit 300 s header timeout, which sat in
 * exactly the wrong place: `v8.writeHeapSnapshot` blocks the child's event
 * loop until the file is on disk, so a multi-GB snapshot that needed more
 * than five minutes failed the route after doing exactly what it was asked.
 * Each bound below is roughly an order of magnitude past the worst case
 * measured in validation (2.9 GB snapshots finished in under five minutes;
 * three GC passes on 3 GB heaps in seconds). The snapshot bound exists so a
 * wedged child cannot hang an unattended run forever, not to police big heaps.
 */
const DEADLINES_MS: Record<string, number> = {
  "/mem": 30_000,
  "/gc": 180_000,
  "/snapshot": 1_800_000,
};
const DEFAULT_DEADLINE_MS = 30_000;

function deadlineFor(pathname: string): number {
  const operation = pathname.split("?")[0] ?? pathname;
  return DEADLINES_MS[operation] ?? DEFAULT_DEADLINE_MS;
}

/**
 * A wall-clock bound cannot tell a wedged child from a working one, and for
 * `/snapshot` that difference decides whether a route gets a verdict.
 *
 * `v8.writeHeapSnapshot` blocks the child's event loop until the file is on
 * disk, so the channel goes silent exactly while the tool is being served.
 * Measured on the vercel/next.js#84648 reproduction: the 1800 s bound expired
 * on a route that was leaking hard, and the 267 MB snapshot (against a 39 MB
 * baseline) landed intact afterwards — the run was thrown away for finishing
 * late. The worse the leak, the bigger the snapshot, so the old bound failed
 * most reliably on the runs that mattered most.
 *
 * The file itself is the heartbeat: bytes arriving mean the child is working,
 * however long it takes. Silence on disk for this long means it is not.
 */
const SNAPSHOT_STALL_MS = 300_000;
/** Polling interval for that heartbeat. Cheap: one `stat` per tick. */
const SNAPSHOT_POLL_MS = 10_000;
/**
 * Absolute ceiling, progress or not. The stall window alone would let a child
 * that trickles a byte a minute hold an unattended run open forever.
 */
const SNAPSHOT_HARD_CAP_MS = 14_400_000;

/** Where the control server will put `<name>.heapsnapshot`, so the client can watch it grow. */
export function snapshotPathFor(workDir: string, name: string): string {
  return path.join(workDir, `${path.basename(name)}.heapsnapshot`);
}

/** Judging a wait by bytes on disk instead of by the clock. */
export type SnapshotWatch = {
  /** The file the measured process is writing. */
  file: string;
  /** Give up after this long with no new bytes. */
  stallMs: number;
  /** Give up after this long regardless of progress. */
  hardCapMs: number;
  /** How often to look. */
  pollMs: number;
};

function productionWatch(file: string): SnapshotWatch {
  return {
    file,
    stallMs: SNAPSHOT_STALL_MS,
    hardCapMs: SNAPSHOT_HARD_CAP_MS,
    pollMs: SNAPSHOT_POLL_MS,
  };
}

/** Bytes on disk so far, or null while the file does not exist yet. */
async function bytesWritten(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

function describeProgress(bytes: number): string {
  return bytes < 0 ? "nothing written yet" : `${(bytes / 1_048_576).toFixed(1)} MB on disk`;
}

function describeDuration(ms: number): string {
  return ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 1000)}s`;
}

/**
 * One loopback GET with this tool's own deadline and nothing else's.
 *
 * `socket.setTimeout` alone is not enough: it fires on idle and a
 * slow-trickling response resets it, while a run's patience is wall-clock.
 * A plain timer plus `request.destroy()` measures the only thing that
 * matters — how long the caller has been waiting.
 */
function get(
  port: number,
  pathname: string,
  deadlineMs: number,
  watch?: SnapshotWatch
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (outcome: { ok: { status: number; body: string } } | { error: Error }): void => {
      if (settled) {
        return;
      }
      settled = true;
      stopTimer();
      if ("ok" in outcome) {
        resolve(outcome.ok);
      } else {
        reject(outcome.error);
      }
    };
    const request = http.get({ host: "127.0.0.1", port, path: pathname }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () =>
        settle({
          ok: { status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") },
        })
      );
    });
    // Giving up rejects directly instead of waiting for a destroy-triggered
    // error event: destroying a request whose response already started does
    // not reliably emit one, and a deadline that only sometimes fires is no
    // deadline at all.
    const giveUp = (reason: string): void => {
      settle({
        error: new ControlError(`control channel ${pathname} on port ${port} ${reason}`),
      });
      request.destroy();
    };

    let timer: NodeJS.Timeout;
    let stopTimer: () => void;
    if (watch === undefined) {
      timer = setTimeout(
        () =>
          giveUp(
            `did not answer within ${Math.round(deadlineMs / 1000)}s — the measured process ` +
              `is wedged or its event loop is blocked`
          ),
        deadlineMs
      );
      stopTimer = (): void => clearTimeout(timer);
    } else {
      // Watch the file, not the clock. A snapshot still growing is a child
      // doing exactly what it was asked, with its event loop blocked — which
      // is the normal way this call succeeds, not a failure to wait out.
      const startedAt = Date.now();
      let lastSize = -1;
      let lastGrewAt = startedAt;
      let checking = false;
      const check = async (): Promise<void> => {
        if (checking || settled) {
          return;
        }
        checking = true;
        try {
          const size = await bytesWritten(watch.file);
          const now = Date.now();
          if (size !== null && size > lastSize) {
            lastSize = size;
            lastGrewAt = now;
          }
          if (now - startedAt >= watch.hardCapMs) {
            giveUp(
              `was still writing after ${describeDuration(watch.hardCapMs)} ` +
                `(${describeProgress(lastSize)}) — giving up so an unattended run can end`
            );
          } else if (now - lastGrewAt >= watch.stallMs) {
            giveUp(
              `wrote nothing for ${describeDuration(watch.stallMs)} ` +
                `(${describeProgress(lastSize)}) — the measured process is wedged`
            );
          }
        } finally {
          checking = false;
        }
      };
      timer = setInterval(() => void check(), watch.pollMs);
      stopTimer = (): void => clearInterval(timer);
    }
    timer.unref();
    // Bare "fetch failed" read like a bug in this tool. Name the channel
    // and the operation: the usual cause is the measured process dying,
    // which the ritual then surfaces via its exit.
    request.once("error", (cause) =>
      settle({
        error: new ControlError(
          `control channel ${pathname} on port ${port} did not answer ` +
            `(${cause.message}) — the measured process is gone or its event loop is blocked`
        ),
      })
    );
  });
}

async function request(
  port: number,
  pathname: string,
  deadlineMs = deadlineFor(pathname),
  watch?: SnapshotWatch
): Promise<unknown> {
  const response = await get(port, pathname, deadlineMs, watch);
  if (response.status !== 200) {
    throw new ControlError(`control channel ${pathname} responded ${response.status}`);
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new ControlError(`control channel ${pathname} answered with malformed JSON`);
  }
}

/** Forces GC in the measured process and returns a settled memory sample. */
export async function requestGc(port: number): Promise<HeapSample> {
  const sample = sampleSchema.parse(await request(port, "/gc"));
  if (!sample.gcExposed) {
    throw new ControlError(
      "the measured process is running without --expose-gc; samples would be meaningless"
    );
  }
  return sample;
}

/**
 * Reads memory without collecting. Used to poll a process under load, where a
 * forced GC would change the number being read.
 */
export async function requestMemory(port: number): Promise<HeapSample> {
  return sampleSchema.parse(await request(port, "/mem"));
}

/**
 * Forces GC, writes a named heap snapshot, and returns its path and sample.
 *
 * Pass `workDir` — the same directory the control server writes into — to have
 * the wait judged by bytes reaching disk rather than by the clock. Without it
 * the call falls back to the plain wall-clock bound, which cannot tell a big
 * snapshot from a wedged process.
 */
export async function requestSnapshot(
  port: number,
  name: string,
  workDir?: string
): Promise<{ file: string; sample: HeapSample }> {
  const pathname = `/snapshot?name=${encodeURIComponent(name)}`;
  const parsed = snapshotResponseSchema.parse(
    await request(
      port,
      pathname,
      deadlineFor(pathname),
      workDir === undefined ? undefined : productionWatch(snapshotPathFor(workDir, name))
    )
  );
  if (!parsed.sample.gcExposed) {
    throw new ControlError(
      "the measured process is running without --expose-gc; samples would be meaningless"
    );
  }
  return parsed;
}

/** Test seam: the production deadlines would make a hung-server test take minutes. */
export const requestWithDeadline = request;

/**
 * Test seam for the disk-progress watch. Same reason as the deadline seam: the
 * production stall window is five minutes, and the behaviour worth proving —
 * that a growing file buys more time and a still one does not — is about the
 * shape of the wait, not its length.
 */
export const requestWatchingFile = request;

/**
 * Test seam for the deadline table itself. A mutation run showed the mapping
 * could quietly send `/snapshot?name=x` to the 30-second default instead of
 * its 30-minute bound — reinstating, from the inside, the exact ceiling this
 * client exists to remove.
 */
export const deadlineForOperation = deadlineFor;
