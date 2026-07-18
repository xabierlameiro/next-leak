import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { LoadError, runLoadPhase } from "./load.js";

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

describe("runLoadPhase", () => {
  it("sends the exact request amount against a healthy route", async () => {
    let seen = 0;
    const port = await listen((req, res) => {
      seen += 1;
      res.end("ok");
    });
    const result = await runLoadPhase({
      url: `http://127.0.0.1:${port}/`,
      amount: 50,
      connections: 5,
    });
    expect(result.ok2xx).toBe(50);
    expect(result.non2xx).toBe(0);
    expect(seen).toBe(50);
  }, 30_000);

  // Regression: a malformed URL makes autocannon report requests as sent with
  // zero recorded responses. Accepting that produced a confident "stable"
  // verdict for a route that was never actually loaded.
  it("fails when requests complete without any recorded 2xx response", async () => {
    const port = await listen((req, res) => res.end("ok"));
    await expect(
      // Unencoded non-ASCII path: autocannon sends nothing usable.
      runLoadPhase({ url: `http://127.0.0.1:${port}/camión`, amount: 30, connections: 5 })
    ).rejects.toBeInstanceOf(LoadError);
  }, 30_000);

  it("reports unanswered requests distinctly in the error message", async () => {
    const port = await listen((req, res) => res.end("ok"));
    await runLoadPhase({ url: `http://127.0.0.1:${port}/ñ`, amount: 10, connections: 2 }).then(
      () => {
        throw new Error("expected a LoadError");
      },
      (error: unknown) => {
        expect(String((error as Error).message)).toContain("no recorded response");
      }
    );
  }, 30_000);

  it("fails the phase when the error budget is exceeded", async () => {
    let n = 0;
    const port = await listen((req, res) => {
      n += 1;
      res.statusCode = n % 2 === 0 ? 500 : 200;
      res.end();
    });
    await expect(
      runLoadPhase({ url: `http://127.0.0.1:${port}/`, amount: 50, connections: 5 })
    ).rejects.toBeInstanceOf(LoadError);
  }, 30_000);
});

// Leaks keyed by URL (route caches, LRUs — vercel/next.js#94890) are invisible
// when every request hits the same path.
describe("unique URL generation", () => {
  it("sends a distinct path per request when the URL contains {n}", async () => {
    const seen: string[] = [];
    const port = await listen((req, res) => {
      seen.push(req.url ?? "");
      res.end("ok");
    });
    const result = await runLoadPhase({
      url: `http://127.0.0.1:${port}/logs/item-{n}`,
      amount: 25,
      connections: 5,
    });
    expect(result.ok2xx).toBe(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen.every((path) => path.startsWith("/logs/item-"))).toBe(true);
  }, 30_000);

  it("keeps a single path when there is no marker", async () => {
    const seen: string[] = [];
    const port = await listen((req, res) => {
      seen.push(req.url ?? "");
      res.end("ok");
    });
    await runLoadPhase({ url: `http://127.0.0.1:${port}/fixed`, amount: 10, connections: 2 });
    expect(new Set(seen)).toEqual(new Set(["/fixed"]));
  }, 30_000);
});

// Real traffic carries headers; some leaks only exist on the code paths they
// unlock (compression, sessions). Measuring header-less measures another app.
describe("request headers", () => {
  it("sends configured headers with every request", async () => {
    const seen: Array<string | undefined> = [];
    const port = await listen((req, res) => {
      seen.push(req.headers["accept-encoding"] as string | undefined);
      res.end("ok");
    });
    await runLoadPhase({
      url: `http://127.0.0.1:${port}/`,
      amount: 10,
      connections: 2,
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(seen).toHaveLength(10);
    expect(seen.every((value) => value === "gzip, br")).toBe(true);
  }, 30_000);
});

// Leaks that only exist when the client gives up (vercel/next.js#89091 traces
// ServerResponse retention to an early disconnect) are unreachable with a load
// generator that always waits for the response.
describe("client abandonment", () => {
  it("does not count deliberate abandonment as failure", async () => {
    const port = await listen((req, res) => {
      // Never answers within the abandon window.
      setTimeout(() => res.end("late"), 5000).unref();
    });
    const result = await runLoadPhase({
      url: `http://127.0.0.1:${port}/slow`,
      amount: 10,
      connections: 5,
      abandonAfterMs: 1000,
    });
    expect(result.timeouts).toBeGreaterThan(0);
    expect(result.ok2xx).toBe(0);
  }, 30_000);

  it("still fails when responses error rather than being abandoned", async () => {
    const port = await listen((req, res) => {
      res.statusCode = 500;
      res.end();
    });
    await expect(
      runLoadPhase({
        url: `http://127.0.0.1:${port}/boom`,
        amount: 20,
        connections: 5,
        abandonAfterMs: 1000,
      })
    ).rejects.toBeInstanceOf(LoadError);
  }, 30_000);
});
