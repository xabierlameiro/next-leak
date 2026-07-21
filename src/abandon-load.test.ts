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
  it("hangs up before a slow response arrives", async () => {
    let started = 0;
    let aborted = 0;
    const port = await listen((req, res) => {
      started += 1;
      req.on("aborted", () => {
        aborted += 1;
      });
      setTimeout(() => res.end("late"), 3000).unref();
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
      setTimeout(() => res.end(), 3000).unref();
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
    const port = await listen((req, res) => {
      received += 1;
      setTimeout(() => res.end(), 3000).unref();
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

  it("separates abandonment before the first byte from mid-stream", async () => {
    const port = await listen((_req, res) => {
      // Answers far later than the abandon window: nothing is ever received.
      setTimeout(() => res.end("late"), 30_000).unref();
    });

    const result = await runAbandonPhase({
      url: `http://127.0.0.1:${port}/x`,
      amount: 20,
      connections: 5,
      abandonAfterMs: 100,
    });

    expect(result.abandoned).toBe(20);
    expect(result.abandonedMidStream).toBe(0);
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
