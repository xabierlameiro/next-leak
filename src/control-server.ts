import { timingSafeEqual } from "node:crypto";
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
  /**
   * Identity of the process that produced this sample. Optional in the type so
   * fixtures stay readable; the wire schema in `control-client.ts` requires it,
   * so a real sample always carries it.
   */
  pid?: number;
  ppid?: number;
  argv?: readonly string[];
  cwd?: string;
  /**
   * HTTP requests this process has served since boot, counted by the probe in
   * `bootstrap.ts`. Recorded as evidence of how much traffic reached the
   * process behind a reading, not checked anywhere: a clustered server counts
   * in whichever process took the connection. `undefined` when the probe was
   * not installed.
   */
  servedRequests?: number | undefined;
};

/** Where `bootstrap.ts` publishes the served-request count. */
export const requestProbe = globalThis as typeof globalThis & {
  __nextLeakServedRequests?: number;
};

function sampleMemory(gcExposed: boolean): HeapSample {
  const usage = process.memoryUsage();
  return {
    gcExposed,
    heapUsed: usage.heapUsed,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv,
    cwd: process.cwd(),
    ...(requestProbe.__nextLeakServedRequests === undefined
      ? {}
      : { servedRequests: requestProbe.__nextLeakServedRequests }),
  };
}

/** Header that carries the shared secret on every control request. */
export const CONTROL_TOKEN_HEADER = "x-next-leak-token";

export type ControlServerOptions = {
  /** Directory where heap snapshots are written. */
  snapshotDir: string;
  /** Secret the launcher generated for this run; a request without it is refused. */
  token: string;
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
 * - `GET /mem` — respond with a memory sample WITHOUT collecting.
 * - `GET /snapshot?name=<label>` — force GC, write `<label>.heapsnapshot`
 *   into `snapshotDir`, respond `{ file, sample }` only once fully written.
 *
 * Every request must carry the run's token. The socket is bound to loopback,
 * which keeps other machines out and nobody else: any local process can reach
 * it, and so can a web page open in a browser on the same machine. Without
 * the token either could read the process's argv and working directory, or
 * ask for heap snapshots until the disk is full.
 */
export async function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
  if (options.token === "") {
    throw new Error("the control server needs a token and was given an empty one");
  }
  const write = options.writeSnapshot ?? writeHeapSnapshot;
  const expected = Buffer.from(options.token);
  const carriesToken = (request: http.IncomingMessage): boolean => {
    const header = request.headers[CONTROL_TOKEN_HEADER];
    if (typeof header !== "string") {
      return false;
    }
    const given = Buffer.from(header);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

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

    if (!carriesToken(request)) {
      respond(403, { error: `missing or wrong ${CONTROL_TOKEN_HEADER} header` });
      return;
    }

    try {
      if (url.pathname === "/gc") {
        const gcExposed = await forceGc();
        respond(200, sampleMemory(gcExposed));
        return;
      }
      if (url.pathname === "/mem") {
        // Deliberately without forceGc(): this is polled while the app is under
        // load, and collecting there would collect memory the app never would
        // have on its own — flattening the very peak the poll exists to see.
        respond(200, sampleMemory(typeof g.gc === "function"));
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
