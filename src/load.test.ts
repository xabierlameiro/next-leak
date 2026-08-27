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


// `{n}` gives every request its own URL; `{n%N}` gives N distinct URLs
// revisited. The reported leaks turn on the second shape — #96533 revalidates
// a fixed set of 200 posts over and over — and until now only the first
// existed.
describe("bounded key cardinality", () => {
  it("cycles through exactly N distinct paths", async () => {
    const seen = new Set<string>();
    const port = await listen((request, response) => {
      seen.add(request.url ?? "");
      response.end("ok");
    });

    await runLoadPhase({
      url: `http://127.0.0.1:${port}/posts/post-{n%5}`,
      amount: 60,
      connections: 4,
    });

    expect(seen.size).toBe(5);
    expect([...seen].sort()).toEqual([
      "/posts/post-0",
      "/posts/post-1",
      "/posts/post-2",
      "/posts/post-3",
      "/posts/post-4",
    ]);
  });

  it("revisits the same keys rather than growing without limit", async () => {
    const counts = new Map<string, number>();
    const port = await listen((request, response) => {
      const path = request.url ?? "";
      counts.set(path, (counts.get(path) ?? 0) + 1);
      response.end("ok");
    });

    await runLoadPhase({
      url: `http://127.0.0.1:${port}/p/{n%3}`,
      amount: 30,
      connections: 2,
    });

    expect(counts.size).toBe(3);
    // Every key seen more than once: that is what "revisited" means.
    expect([...counts.values()].every((count) => count > 1)).toBe(true);
  });

  it("keeps the error budget working on bounded paths", async () => {
    const port = await listen((_request, response) => {
      response.statusCode = 500;
      response.end("no");
    });

    await expect(
      runLoadPhase({ url: `http://127.0.0.1:${port}/p/{n%4}`, amount: 20, connections: 2 })
    ).rejects.toBeInstanceOf(LoadError);
  });

  it("preserves the query string alongside the bound", async () => {
    const seen = new Set<string>();
    const port = await listen((request, response) => {
      seen.add(request.url ?? "");
      response.end("ok");
    });

    await runLoadPhase({
      url: `http://127.0.0.1:${port}/p/{n%2}?weightKb=8`,
      amount: 10,
      connections: 2,
    });

    expect([...seen].sort()).toEqual(["/p/0?weightKb=8", "/p/1?weightKb=8"]);
  });

  it("leaves unbounded {n} giving every request its own URL", async () => {
    const seen = new Set<string>();
    const port = await listen((request, response) => {
      seen.add(request.url ?? "");
      response.end("ok");
    });

    await runLoadPhase({
      url: `http://127.0.0.1:${port}/p/{n}`,
      amount: 25,
      connections: 2,
    });

    expect(seen.size).toBeGreaterThan(20);
  });
});

// A failed load phase says the run did not happen; it does not say whose fault
// that is, and the two causes need opposite responses from the user.
describe("saturation is not the same as a broken route", () => {
  it("names --connections when the failures are timeouts", async () => {
    // The #97424 shape: 0 non-2xx, all timeouts, because each render fans out
    // to 30 fetches and 5 concurrent renders is already too many.
    const port = await listen((_request, response) => {
      // Never answers: every request times out.
      void response;
    });

    const failure = await runLoadPhase({
      url: `http://127.0.0.1:${port}/`,
      amount: 8,
      connections: 4,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LoadError);
    const message = (failure as LoadError).message;
    expect(message).toContain("timeouts rather than error responses");
    expect(message).toContain("--connections (currently 4)");
    expect(message).toContain("before concluding anything about memory");
  }, 60_000);

  it("blames the route when it answers with errors, and does not suggest less load", async () => {
    const port = await listen((_request, response) => {
      response.statusCode = 500;
      response.end("no");
    });

    const failure = await runLoadPhase({
      url: `http://127.0.0.1:${port}/`,
      amount: 20,
      connections: 2,
    }).catch((error: unknown) => error);

    const message = (failure as LoadError).message;
    expect(message).toContain("answered with errors under load");
    expect(message).not.toContain("--connections");
  });

  it("says nothing extra when the load stayed within budget", async () => {
    const port = await listen((_request, response) => response.end("ok"));

    await expect(
      runLoadPhase({ url: `http://127.0.0.1:${port}/`, amount: 10, connections: 2 })
    ).resolves.toBeDefined();
  });
});

// Measured against a real app with `post-0..post-2` prerendered and
// `dynamicParams = false`: the varying value made every request a 404 and the
// run told the user the fault was in their route. It was not.
describe("a closed param set is not a broken route", () => {
  /** Serves only the params a build would have prerendered. */
  const closedParamSet = (prerendered: number): http.RequestListener => {
    return (req, res) => {
      const slug = (req.url ?? "").replace(/^\/post-/, "");
      if (Number(slug) < prerendered) {
        res.end("ok");
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    };
  };

  it("blames the sample value, not the route, when only novel params 404", async () => {
    const port = await listen(closedParamSet(3));
    const failure = await runLoadPhase({
      url: `http://127.0.0.1:${port}/post-{n}`,
      amount: 40,
      connections: 4,
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(LoadError);
    const message = (failure as LoadError).message;
    expect(message).toContain("never prerendered");
    expect(message).toContain("the route itself is fine");
    // The old, wrong diagnosis must be gone.
    expect(message).not.toContain("fault in the route");
  });

  it("names the bounded marker as the way out", async () => {
    const port = await listen(closedParamSet(3));
    const failure = await runLoadPhase({
      url: `http://127.0.0.1:${port}/post-{n}`,
      amount: 40,
      connections: 4,
    }).catch((cause: unknown) => cause);

    expect((failure as LoadError).message).toContain("{n%N}");
  });

  // A route that is genuinely broken answers badly for every value, including
  // the one the build prerendered, so the probe must not claim the value is at
  // fault and must let the route diagnosis speak.
  it("still blames the route when even a prerendered param fails", async () => {
    const port = await listen((_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    const failure = await runLoadPhase({
      url: `http://127.0.0.1:${port}/post-{n}`,
      amount: 40,
      connections: 4,
    }).catch((cause: unknown) => cause);

    const message = (failure as LoadError).message;
    expect(message).toContain("fault in the route");
    expect(message).not.toContain("never prerendered");
  });

  it("says nothing about params when the path carries no marker", async () => {
    const port = await listen(closedParamSet(0));
    const failure = await runLoadPhase({
      url: `http://127.0.0.1:${port}/post-7`,
      amount: 40,
      connections: 4,
    }).catch((cause: unknown) => cause);

    expect((failure as LoadError).message).not.toContain("never prerendered");
  });
});
