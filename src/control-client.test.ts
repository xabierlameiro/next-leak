import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deadlineForOperation,
  requestGc,
  requestMemory,
  requestSnapshot,
  requestWatchingFile,
  requestWithDeadline,
  snapshotPathFor,
} from "./control-client.js";

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

  it("is a named error type, so reports can distinguish it from app failures", async () => {
    const failure = await requestGc(1).catch((cause: Error) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("ControlError");
  });

  it("refuses samples from a process running without --expose-gc", async () => {
    // Such samples are not settled: reporting them as post-GC numbers would
    // be the classic false measurement the ritual exists to prevent.
    const sample = { gcExposed: false, heapUsed: 1, rss: 1, external: 0, arrayBuffers: 0 };
    const port = await listen((req, res) => {
      if (req.url?.startsWith("/snapshot")) {
        res.end(JSON.stringify({ file: "/x.heapsnapshot", sample }));
        return;
      }
      res.end(JSON.stringify(sample));
    });
    await expect(requestGc(port)).rejects.toThrow(/without --expose-gc/);
    await expect(requestSnapshot(port, "after")).rejects.toThrow(/without --expose-gc/);
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
  it("maps every operation to its own bound, query string included", () => {
    // `/snapshot?name=x` falling back to the 30s default would reinstate the
    // hidden snapshot ceiling this client exists to remove.
    expect(deadlineForOperation("/snapshot?name=after")).toBe(1_800_000);
    expect(deadlineForOperation("/gc")).toBe(180_000);
    expect(deadlineForOperation("/mem")).toBe(30_000);
    expect(deadlineForOperation("/anything-else")).toBe(30_000);
  });

  it("gives up on a server that accepts and never answers, naming the wait", async () => {
    const port = await listen(() => {
      // Accept the request, never respond: the wedged-child shape.
    });
    await expect(requestWithDeadline(port, "/gc", 200)).rejects.toThrow(
      /did not answer within 0s — the measured process is wedged or its event loop is blocked/
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

/**
 * `v8.writeHeapSnapshot` blocks the measured process's event loop until the
 * file is on disk, so the channel goes silent exactly while it is doing the
 * work. A wall-clock bound cannot tell that apart from a wedged child, and got
 * it wrong in the direction that matters: measured on the
 * vercel/next.js#84648 reproduction, the old 1800 s bound failed a leaking
 * route whose 267 MB snapshot landed intact moments later. The bigger the
 * leak, the bigger the snapshot — so it failed hardest on the runs worth
 * keeping. Bytes reaching disk are the heartbeat instead.
 */
describe("snapshot waits judged by progress on disk", () => {
  let dir: string;

  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * A writer that only ever makes the file bigger, one append at a time.
   *
   * Serialized on purpose: overlapping appends are what let the poll observe a
   * size that is not monotonic, and the whole point of the file-watching path
   * is that growth is the signal.
   */
  function appendingWriter(file: string): () => Promise<void> {
    let writing = false;
    return async () => {
      if (writing) {
        return;
      }
      writing = true;
      try {
        await appendFile(file, Buffer.alloc(1024));
      } finally {
        writing = false;
      }
    };
  }

  async function tempDir(): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), "next-leak-watch-"));
    return dir;
  }

  it("keeps waiting while the file is still growing, past the stall window", async () => {
    const workDir = await tempDir();
    const file = snapshotPathFor(workDir, "after");
    // Answers only after several stall windows would have expired. A growing
    // file has to be enough to hold the wait open that long.
    const port = await listen((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            file,
            sample: { gcExposed: true, heapUsed: 1, rss: 1, external: 1, arrayBuffers: 1 },
          })
        );
      }, 400);
    });
    // A real snapshot is appended to, never rewritten. `writeFile` truncates to
    // zero on every tick, and the poll reads that zero: measured on this
    // pattern, 11 of 138 reads came back 0 and 11 went backwards. Since the
    // watcher only refreshes its stall clock when the file *grows*, a run of
    // those reads inside one stall window is enough to declare a healthy child
    // wedged — which is how this test failed on CI once.
    const grow = appendingWriter(file);
    // Growing before the wait starts means the first poll reads a real size
    // rather than a missing file, and appending every 10 ms leaves the widest
    // observed gap between growths (30 ms, measured) well inside the 100 ms
    // stall window without relaxing the window itself.
    await grow();
    const growing = setInterval(() => void grow(), 10);
    try {
      const answer = await requestWatchingFile(port, "/snapshot?name=after", 60_000, {
        file,
        stallMs: 100,
        hardCapMs: 60_000,
        pollMs: 10,
      });
      expect(answer).toMatchObject({ file });
    } finally {
      clearInterval(growing);
    }
  });

  it("gives up on a file that stops growing, and says how far it got", async () => {
    const workDir = await tempDir();
    const file = snapshotPathFor(workDir, "after");
    await writeFile(file, Buffer.alloc(2 * 1_048_576));
    const port = await listen(() => {
      // Accept and never answer: the wedged-child shape.
    });
    await expect(
      requestWatchingFile(port, "/snapshot?name=after", 60_000, {
        file,
        stallMs: 100,
        hardCapMs: 60_000,
        pollMs: 10,
      })
    ).rejects.toThrow(/wrote nothing for 0s \(2\.0 MB on disk\) — the measured process is wedged/);
  });

  it("still ends an unattended run when the file grows forever", async () => {
    const workDir = await tempDir();
    const file = snapshotPathFor(workDir, "after");
    const port = await listen(() => {
      // Never answers; the file below never stops growing either.
    });
    const grow = appendingWriter(file);
    const growing = setInterval(() => void grow(), 10);
    try {
      await expect(
        requestWatchingFile(port, "/snapshot?name=after", 60_000, {
          file,
          stallMs: 60_000,
          hardCapMs: 200,
          pollMs: 10,
        })
      ).rejects.toThrow(/was still writing after .* — giving up so an unattended run can end/);
    } finally {
      clearInterval(growing);
    }
  });

  it("reports nothing written when the snapshot file never appears", async () => {
    const workDir = await tempDir();
    const port = await listen(() => {
      // Accept and never answer, with no file ever created.
    });
    await expect(
      requestWatchingFile(port, "/snapshot?name=after", 60_000, {
        file: snapshotPathFor(workDir, "after"),
        stallMs: 100,
        hardCapMs: 60_000,
        pollMs: 10,
      })
    ).rejects.toThrow(/nothing written yet/);
  });
});
