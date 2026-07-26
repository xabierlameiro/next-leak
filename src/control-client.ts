import http from "node:http";
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
  deadlineMs: number
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (outcome: { ok: { status: number; body: string } } | { error: Error }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
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
    // The timer rejects directly instead of waiting for a destroy-triggered
    // error event: destroying a request whose response already started does
    // not reliably emit one, and a deadline that only sometimes fires is no
    // deadline at all.
    const timer = setTimeout(() => {
      settle({
        error: new ControlError(
          `control channel ${pathname} on port ${port} did not answer within ` +
            `${Math.round(deadlineMs / 1000)}s — the measured process is wedged, or this ` +
            `snapshot is larger than anything this tool has been validated on`
        ),
      });
      request.destroy();
    }, deadlineMs);
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
  deadlineMs = deadlineFor(pathname)
): Promise<unknown> {
  const response = await get(port, pathname, deadlineMs);
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

/** Forces GC, writes a named heap snapshot, and returns its path and sample. */
export async function requestSnapshot(
  port: number,
  name: string
): Promise<{ file: string; sample: HeapSample }> {
  const parsed = snapshotResponseSchema.parse(
    await request(port, `/snapshot?name=${encodeURIComponent(name)}`)
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
 * Test seam for the deadline table itself. A mutation run showed the mapping
 * could quietly send `/snapshot?name=x` to the 30-second default instead of
 * its 30-minute bound — reinstating, from the inside, the exact ceiling this
 * client exists to remove.
 */
export const deadlineForOperation = deadlineFor;
