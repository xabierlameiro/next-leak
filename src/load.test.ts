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

// Killed mutants: the redirect explainer's status window, the error budget's
// exact boundary, and the failure message's arithmetic were all mutable
// without a test noticing.
describe("mutation-hardening: load", () => {
  it("names the redirect target across the whole 3xx window, and only there", async () => {
    const at = async (status: number, location?: string): Promise<() => Promise<unknown>> => {
      const port = await listen((_req, res) => {
        res.statusCode = status;
        if (location !== undefined) {
          res.setHeader("location", location);
        }
        res.end();
      });
      return () => runLoadPhase({ url: `http://127.0.0.1:${port}/`, amount: 20, connections: 2 });
    };

    // 300 is inside the window: the message must point at the target.
    await expect((await at(300, "/es"))()).rejects.toThrow(/redirects \(300\) to "\/es"/);
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));

    // 400 is outside it: a location header there is not a redirect.
    await expect((await at(400, "/es"))()).rejects.toThrow(LoadError);
    await expect((await at(400, "/es"))()).rejects.not.toThrow(/redirects/);
  }, 30_000);

  it("tolerates failures exactly at the error budget", async () => {
    // 1 failure in 100 requests sits exactly ON the 1% budget: the phase must
    // pass — the budget is "more than", not "at least".
    let served = 0;
    const port = await listen((_req, res) => {
      served += 1;
      res.statusCode = served === 1 ? 500 : 200;
      res.end("ok");
    });
    const result = await runLoadPhase({
      url: `http://127.0.0.1:${port}/`,
      amount: 100,
      connections: 1,
    });
    expect(result.non2xx).toBe(1);
  }, 30_000);

  it("does not report phantom unanswered requests when every failure answered", async () => {
    // Every request gets a real 500: failures == non2xx, so the "no recorded
    // response" clause must stay out of the message. A sign flip in that
    // arithmetic invents unanswered requests out of answered ones.
    const port = await listen((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    await runLoadPhase({ url: `http://127.0.0.1:${port}/`, amount: 30, connections: 3 }).then(
      () => {
        throw new Error("expected a LoadError");
      },
      (error: unknown) => {
        const message = String((error as Error).message);
        expect(message).toContain("30 non-2xx");
        expect(message).not.toContain("no recorded response");
      }
    );
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

