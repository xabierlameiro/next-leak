import http from "node:http";
import path from "node:path";
import { writeHeapSnapshot } from "node:v8";

const g = globalThis as typeof globalThis & { gc?: () => void };
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Forces garbage collection. A single pass is not enough to settle the heap;
 * phase-0 measurements used 3 passes separated by event-loop ticks so that
 * finalizers and pending callbacks can release references between passes.
 * Returns false when the process was not started with `--expose-gc`.
 */
export async function forceGc(passes = 3): Promise<boolean> {
  if (typeof g.gc !== "function") {
    return false;
  }
  for (let i = 0; i < passes; i += 1) {
    g.gc();
    await tick();
  }
  return true;
}

export type HeapSample = {
  gcExposed: boolean;
  heapUsed: number;
  rss: number;
  external: number;
  arrayBuffers: number;
};

function sampleMemory(gcExposed: boolean): HeapSample {
  const usage = process.memoryUsage();
  return {
    gcExposed,
    heapUsed: usage.heapUsed,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

export type ControlServerOptions = {
  /** Directory where heap snapshots are written. */
  snapshotDir: string;
  /** Injectable for tests; defaults to `v8.writeHeapSnapshot`. */
  writeSnapshot?: (file: string) => string;
};

export type ControlServer = {
  port: number;
  close: () => Promise<void>;
};

/**
 * Internal control channel booted inside the measured app's process.
 *
 * - `GET /gc` — force GC, respond with a memory sample.
 * - `GET /snapshot?name=<label>` — force GC, write `<label>.heapsnapshot`
 *   into `snapshotDir`, respond `{ file, sample }` only once fully written.
 */
export async function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
  const write = options.writeSnapshot ?? writeHeapSnapshot;

  const server = http.createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://control.local");
    const respond = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    try {
      if (url.pathname === "/gc") {
        const gcExposed = await forceGc();
        respond(200, sampleMemory(gcExposed));
        return;
      }
      if (url.pathname === "/snapshot") {
        const name = url.searchParams.get("name");
        if (name === null || name === "") {
          respond(400, { error: "missing ?name=<label>" });
          return;
        }
        const gcExposed = await forceGc();
        // Sampled BEFORE writing: v8.writeHeapSnapshot forces a full
        // mark-compact of its own, deeper than global.gc(). Sampling after it
        // measured the final point of every series under a GC regime the
        // other points never saw, so it always read low — and since one flat
        // cycle is enough for a `stable` verdict, that silently buried real
        // leaks (found measuring vercel/next.js#95094: +18.8, +16.8, -0.01 MB).
        const sample = sampleMemory(gcExposed);
        const file = write(
          path.join(options.snapshotDir, `${path.basename(name)}.heapsnapshot`)
        );
        respond(200, { file, sample });
        return;
      }
      respond(404, { error: `unknown path ${url.pathname}` });
    } catch (cause) {
      respond(500, { error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  // Measuring must not change what is measured: an open control socket would
  // otherwise keep the host process alive after its own work is done.
  server.unref();

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("control server has no bound port");
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
