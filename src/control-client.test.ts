import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { requestGc, requestMemory, requestWithDeadline } from "./control-client.js";

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

// The control channel's failures reach users verbatim inside route reports.
// A bare "fetch failed" reads like a bug in this tool; the error must say
// which channel, which operation, and what that usually means.
describe("control channel errors", () => {
  it("names the operation and the likely cause when nothing answers", async () => {
    // A port nothing listens on: the same shape as a measured process that died.
    await expect(requestGc(1)).rejects.toThrow(/control channel \/gc on port 1/);
    await expect(requestGc(1)).rejects.toThrow(/gone or its event loop is blocked/);
    await expect(requestMemory(1)).rejects.toThrow(/\/mem/);
  });

  it("rejects malformed JSON with the channel named", async () => {
    const port = await listen((_req, res) => res.end("not json"));
    await expect(requestWithDeadline(port, "/gc")).rejects.toThrow(/malformed JSON/);
  });

  it("reports non-200 answers by status", async () => {
    const port = await listen((_req, res) => {
      res.statusCode = 500;
      res.end("{}");
    });
    await expect(requestWithDeadline(port, "/gc")).rejects.toThrow(/responded 500/);
  });
});

// fetch rode on undici's hidden 300s header timeout — wrong in both
// directions: it failed legitimate multi-GB snapshots at five minutes, and it
// let a wedged child hold every poll for those same five minutes. The client
// now owns its deadlines, so both directions are testable.
describe("control channel deadlines", () => {
  it("gives up on a server that accepts and never answers, naming the wait", async () => {
    const port = await listen(() => {
      // Accept the request, never respond: the wedged-child shape.
    });
    await expect(requestWithDeadline(port, "/gc", 200)).rejects.toThrow(
      /did not answer within 0s — the measured process is wedged/
    );
  });

  it("waits out a response slower than any hidden client timeout would allow", async () => {
    // Scaled-down proof that the deadline is ours: the response arrives after
    // a delay, and only our own bound decides whether that is too late.
    const port = await listen((_req, res) => {
      setTimeout(() => {
        res.end(JSON.stringify({ ok: true }));
      }, 300).unref();
    });
    await expect(requestWithDeadline(port, "/snapshot?name=x", 5000)).resolves.toEqual({
      ok: true,
    });
  });

  it("a slow trickle is judged by wall clock, not by idle time between bytes", async () => {
    const port = await listen((_req, res) => {
      res.write("{");
      // Keeps the socket busy forever, a few bytes at a time. An idle-based
      // timeout would reset on every chunk and never fire.
      const trickle = setInterval(() => res.write(" "), 50);
      trickle.unref();
    });
    await expect(requestWithDeadline(port, "/mem", 300)).rejects.toThrow(/within 0s/);
  }, 10_000);
});
