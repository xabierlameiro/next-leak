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

async function request(port: number, pathname: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  } catch (cause) {
    // Bare "fetch failed" reads like a bug in this tool. Name the channel and
    // the operation: the usual causes are the measured process dying (the
    // ritual then surfaces its exit) or, on multi-GB heaps, a snapshot write
    // blocking the child's event loop past the HTTP client's own timeout.
    throw new ControlError(
      `control channel ${pathname} on port ${port} did not answer ` +
        `(${cause instanceof Error ? cause.message : String(cause)}) — ` +
        `the measured process is gone or its event loop is blocked`
    );
  }
  if (!response.ok) {
    throw new ControlError(`control channel ${pathname} responded ${response.status}`);
  }
  return response.json();
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
