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

export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}

async function request(port: number, pathname: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
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
