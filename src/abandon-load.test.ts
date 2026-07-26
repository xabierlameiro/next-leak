import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runAbandonPhase } from "./abandon-load.js";

let server: http.Server | undefined;

function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (address === undefined || address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve(address.port);
    });
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

// autocannon cannot express this: its timeout is in whole seconds, so a route
// answering in milliseconds is never abandoned. Real leaks live on that path
// (vercel/next.js#89091: ServerResponse retained after an early disconnect).
describe("runAbandonPhase", () => {
  it("hangs up on a route that starts streaming and never finishes", async () => {
    let started = 0;
    const port = await listen((_req, res) => {
      started += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("chunk");
      setTimeout(() => res.end("late"), 30_000).unref();
    });

    const result = await runAbandonPhase({
      url: `http://127.0.0.1:${port}/slow`,
      amount: 10,
      connections: 5,
      abandonAfterMs: 30,
    });

    expect(result.sent).toBe(10);
    expect(result.abandoned).toBe(10);
    expect(result.completed).toBe(0);
    // The client hangs up as soon as it has written, so on a loaded runner the
    // server can still be parsing the last requests when the phase resolves.
    // Waiting for the count removes that race instead of weakening the check:
    // if the requests genuinely never arrive, this still fails.
    const deadline = Date.now() + 10_000;
    while (started < 10 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(started).toBe(10);
  }, 30_000);

  it("counts responses that beat the abandon window as completed", async () => {
    const port = await listen((req, res) => res.end("fast"));
    const result = await runAbandonPhase({
      url: `http://127.0.0.1:${port}/fast`,
      amount: 10,
      connections: 5,
      abandonAfterMs: 2000,
    });
    expect(result.completed).toBe(10);
    expect(result.abandoned).toBe(0);
  }, 30_000);

  it("sends configured headers on the abandoned requests", async () => {
    const seen: Array<string | undefined> = [];
    const port = await listen((req, res) => {
      seen.push(req.headers["accept-encoding"] as string | undefined);
      res.write("chunk");
      setTimeout(() => res.end(), 30_000).unref();
    });
    await runAbandonPhase({
      url: `http://127.0.0.1:${port}/x`,
      amount: 4,
      connections: 2,
      abandonAfterMs: 30,
      headers: { "accept-encoding": "gzip" },
    });
    expect(seen).toHaveLength(4);
    expect(seen.every((value) => value === "gzip")).toBe(true);
  }, 30_000);
});

// Caught by the run.json audit trail: the abandon timer used to start when
// the socket was created, so under concurrency most "abandoned" requests were
// never actually sent — the server never saw them and the experiment proved
// nothing.
describe("abandonment accounting", () => {
  it("only counts requests that actually reached the server", async () => {
    let received = 0;
    const port = await listen((_req, res) => {
      received += 1;
      res.write("chunk");
      setTimeout(() => res.end(), 30_000).unref();
    });

    const result = await runAbandonPhase({
      url: `http://127.0.0.1:${port}/x`,
      amount: 200,
      connections: 100,
      abandonAfterMs: 20,
    });

    expect(result.sent).toBe(200);
    expect(result.abandoned).toBe(200);
    // The client hangs up as soon as it has written, so the server may still
    // be parsing the last requests when runAbandonPhase resolves. Waiting for
    // the count removes that race instead of loosening the assertion: if the
    // requests genuinely never arrive, this still fails.
    const deadline = Date.now() + 10_000;
    while (received < 200 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(received).toBe(200);
    // Never more abandonments than requests actually sent.
    expect(result.abandoned).toBeLessThanOrEqual(result.sent);
  }, 60_000);
});

// Mutation survivors that mattered: a wrong header join corrupts the request,
// an unhandled connect error hangs the phase, and losing the concurrency cap
// silently turns `--connections 24` into 1500 sockets.
describe("request shape and limits", () => {
  it("sends every configured header on its own line", async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const port = await listen((req, res) => {
      seen.push(req.headers);
      res.write("chunk");
      setTimeout(() => res.end(), 30_000).unref();
    });

    await runAbandonPhase({
      url: `http://127.0.0.1:${port}/x`,
      amount: 2,
      connections: 1,
      abandonAfterMs: 20,
      headers: { "accept-encoding": "gzip", "x-probe": "yes" },
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.["accept-encoding"]).toBe("gzip");
    expect(seen[0]?.["x-probe"]).toBe("yes");
  }, 30_000);

  it("counts connect errors instead of hanging the phase", async () => {
    const port = await listen(() => undefined);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    const result = await runAbandonPhase({
      url: `http://127.0.0.1:${port}/x`,
      amount: 4,
      connections: 2,
      abandonAfterMs: 10,
    });

    expect(result.errors).toBe(4);
    expect(result.sent).toBe(0);
    expect(result.completed).toBe(0);
  }, 30_000);

  it("never opens more sockets at once than the configured connections", async () => {
    let open = 0;
    let peak = 0;
    const port = await listen((_req, res) => {
      res.write("chunk");
      setTimeout(() => res.end(), 30_000).unref();
    });
    server?.on("connection", (socket) => {
      open += 1;
      peak = Math.max(peak, open);
      socket.once("close", () => {
        open -= 1;
      });
    });

    await runAbandonPhase({
      url: `http://127.0.0.1:${port}/x`,
      amount: 40,
      connections: 4,
      abandonAfterMs: 15,
    });

    // One over the cap is the socket already destroyed whose `close` has not
    // propagated to the server yet; the in-flight requests are still 4. What
    // this guards against is the cap being ignored altogether (40 at once).
    expect(peak).toBeLessThanOrEqual(5);
  }, 60_000);
});

// vercel/next.js#94919 retains the RSC stream's tee branch when a client
// reads part of a response and disappears. Closing on the first byte made
// that scenario impossible to reproduce: the run only ever tested clients
// that left before the server said anything.
describe("mid-stream abandonment", () => {
  it("counts an abandonment that happened after the response started", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first chunk");
      // Never ends: the client must be the one to give up.
      setTimeout(() => res.end(), 30_000).unref();
    });

    const result = await runAbandonPhase({
      url: `http://127.0.0.1:${port}/x`,
      amount: 20,
      connections: 5,
      abandonAfterMs: 300,
    });

    expect(result.sent).toBe(20);
    expect(result.abandoned).toBe(20);
    expect(result.abandonedMidStream).toBe(20);
    expect(result.completed).toBe(0);
  }, 60_000);

  // The fix for the connect-relative deadline: under load a server's first
  // byte arrives long after any sane `abandonAfterMs`. Measured against the
  // #94919 repro, the old timing produced 2 mid-stream cuts out of ~1500.
  it("waits for the first byte however late it is, then cuts mid-stream", async () => {
    const port = await listen((_req, res) => {
      // First byte far beyond the abandon window, exactly like a saturated
      // route: the deadline must start here, not when the request was sent.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first chunk");
      }, 400).unref();
      setTimeout(() => res.end(), 30_000).unref();
    });

    const result = await runAbandonPhase({
      url: `http://127.0.0.1:${port}/x`,
      amount: 10,
      connections: 5,
      abandonAfterMs: 20,
    });

    expect(result.abandoned).toBe(10);
    expect(result.abandonedMidStream).toBe(10);
    expect(result.abandonedBeforeResponse).toBe(0);
  }, 60_000);

  // Caught by mutation testing: without the early return in the data handler,
  // every chunk re-arms the timer and the cut lands `abandonAfterMs` after the
  // LAST byte instead of the first — on a stream that keeps sending, that is
  // never. The deadline must be relative to the start of the response.
  it("cuts relative to the first byte, not the last, on a chunked stream", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first");
      // Keeps sending well past the abandon window; a last-byte-relative
      // deadline would never fire while this runs.
      const chunker = setInterval(() => res.write("more"), 20);
      chunker.unref();
      setTimeout(() => {
        clearInterval(chunker);
        res.end();
      }, 30_000).unref();
    });

    const started = Date.now();
    const result = await runAbandonPhase({
      url: `http://127.0.0.1:${port}/x`,
      amount: 6,
      connections: 3,
      abandonAfterMs: 30,
    });

    expect(result.abandonedMidStream).toBe(6);
    expect(result.completed).toBe(0);
    // Two rounds of ~30ms cuts, not two rounds of "whenever the stream stops".
    expect(Date.now() - started).toBeLessThan(5000);
  }, 60_000);

  // Also from mutation testing: an unhandled socket error left the request
  // promise pending forever, which would hang a load phase rather than fail it.
  // What a hang-up looks like to the client is platform-dependent — macOS
  // reports an error where Linux sees a clean close — so the invariant worth
  // asserting is that the phase ends and every request is accounted for.
  it("finishes the phase when the server hangs up on every connection", async () => {
    const port = await listen(() => {
      // Never responds; the socket is destroyed from the server side below.
    });
    server?.on("connection", (socket) => {
      socket.destroy(new Error("boom"));
    });

    const result = await runAbandonPhase({
      url: `http://127.0.0.1:${port}/x`,
      amount: 4,
      connections: 2,
      abandonAfterMs: 10,
    });

    expect(result.errors + result.abandoned + result.completed).toBe(4);
  }, 30_000);

  it("gives up on a route that never sends a byte, counting it pre-response", async () => {
    const port = await listen(() => {
      // Never responds at all: only the first-byte budget can end this.
      });

    const result = await runAbandonPhase({
      url: `http://127.0.0.1:${port}/x`,
      amount: 4,
      connections: 4,
      abandonAfterMs: 10,
    });

    expect(result.abandoned).toBe(4);
    expect(result.abandonedMidStream).toBe(0);
    expect(result.abandonedBeforeResponse).toBe(4);
  }, 60_000);

  it("counts a response that finished in time as completed, not abandoned", async () => {
    const port = await listen((_req, res) => res.end("done"));

    const result = await runAbandonPhase({
      url: `http://127.0.0.1:${port}/x`,
      amount: 20,
      connections: 5,
      abandonAfterMs: 3000,
    });

    expect(result.completed).toBe(20);
    expect(result.abandoned).toBe(0);
  }, 60_000);
});
