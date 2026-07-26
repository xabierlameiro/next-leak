import { afterEach, describe, expect, it, vi } from "vitest";
import { forceGc, startControlServer, type ControlServer } from "./control-server.js";

let server: ControlServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("forceGc", () => {
  it("reports whether GC is exposed instead of throwing", async () => {
    // Vitest does not run with --expose-gc, so the honest answer here is
    // exactly `false` — a hardcoded `true` would claim samples are settled
    // when nothing was ever collected.
    await expect(forceGc()).resolves.toBe(false);
  });

  it("runs exactly the requested passes when GC is exposed", async () => {
    const g = globalThis as typeof globalThis & { gc?: () => void };
    const original = g.gc;
    const collect = vi.fn();
    g.gc = collect;
    try {
      await expect(forceGc()).resolves.toBe(true);
      // Three passes are the validated protocol; a fourth would silently
      // change every post-GC sample's regime.
      expect(collect).toHaveBeenCalledTimes(3);
    } finally {
      if (original === undefined) {
        delete g.gc;
      } else {
        g.gc = original;
      }
    }
  });
});

describe("startControlServer", () => {
  it("serves memory samples on /gc", async () => {
    server = await startControlServer({ snapshotDir: "/unused" });
    const response = await fetch(`http://127.0.0.1:${server.port}/gc`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["heapUsed"]).toBeTypeOf("number");
    expect(body["rss"]).toBeTypeOf("number");
    // No --expose-gc in vitest: the flag must say so, not guess.
    expect(body["gcExposed"]).toBe(false);
  });

  it("samples on /mem without collecting", async () => {
    // The peak poller runs this while the app is under load: collecting there
    // would flatten the peak it exists to measure.
    const g = globalThis as typeof globalThis & { gc?: () => void };
    const original = g.gc;
    const collect = vi.fn();
    g.gc = collect;
    try {
      server = await startControlServer({ snapshotDir: "/unused" });
      const response = await fetch(`http://127.0.0.1:${server.port}/mem`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["heapUsed"]).toBeTypeOf("number");
      expect(body["arrayBuffers"]).toBeTypeOf("number");
      // With a gc function installed the flag must reflect it — the ritual
      // rejects processes whose samples would be meaningless.
      expect(body["gcExposed"]).toBe(true);
      expect(collect).not.toHaveBeenCalled();

      await fetch(`http://127.0.0.1:${server.port}/gc`);
      expect(collect).toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete g.gc;
      } else {
        g.gc = original;
      }
    }
  });

  it("writes a named snapshot and responds with the file path", async () => {
    const written: string[] = [];
    server = await startControlServer({
      snapshotDir: "/snapshots",
      writeSnapshot: (file) => {
        written.push(file);
        return file;
      },
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/snapshot?name=baseline`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { file: string };
    expect(body.file).toBe("/snapshots/baseline.heapsnapshot");
    expect(written).toEqual(["/snapshots/baseline.heapsnapshot"]);
  });

  it("sanitizes snapshot labels to their basename", async () => {
    const written: string[] = [];
    server = await startControlServer({
      snapshotDir: "/snapshots",
      writeSnapshot: (file) => {
        written.push(file);
        return file;
      },
    });
    await fetch(`http://127.0.0.1:${server.port}/snapshot?name=../../etc/evil`);
    expect(written).toEqual(["/snapshots/evil.heapsnapshot"]);
  });

  it("rejects snapshot requests without a name, saying what was missing", async () => {
    server = await startControlServer({ snapshotDir: "/unused" });
    const response = await fetch(`http://127.0.0.1:${server.port}/snapshot`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("?name=");
  });

  it("returns 404 for unknown paths, naming the path", async () => {
    server = await startControlServer({ snapshotDir: "/unused" });
    const response = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("/nope");
  });
});
