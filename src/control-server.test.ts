import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_TOKEN_HEADER,
  forceGc,
  startControlServer,
  type ControlServer,
} from "./control-server.js";

const token = "test-token";
const authorized = { headers: { [CONTROL_TOKEN_HEADER]: token } };

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
    server = await startControlServer({ snapshotDir: "/unused", token });
    const response = await fetch(`http://127.0.0.1:${server.port}/gc`, authorized);
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
      server = await startControlServer({ snapshotDir: "/unused", token });
      const response = await fetch(`http://127.0.0.1:${server.port}/mem`, authorized);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["heapUsed"]).toBeTypeOf("number");
      expect(body["arrayBuffers"]).toBeTypeOf("number");
      // With a gc function installed the flag must reflect it — the ritual
      // rejects processes whose samples would be meaningless.
      expect(body["gcExposed"]).toBe(true);
      expect(collect).not.toHaveBeenCalled();

      await fetch(`http://127.0.0.1:${server.port}/gc`, authorized);
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
      token,
      writeSnapshot: (file) => {
        written.push(file);
        return file;
      },
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/snapshot?name=baseline`, authorized);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { file: string };
    expect(body.file).toBe("/snapshots/baseline.heapsnapshot");
    expect(written).toEqual(["/snapshots/baseline.heapsnapshot"]);
  });

  it("sanitizes snapshot labels to their basename", async () => {
    const written: string[] = [];
    server = await startControlServer({
      snapshotDir: "/snapshots",
      token,
      writeSnapshot: (file) => {
        written.push(file);
        return file;
      },
    });
    await fetch(`http://127.0.0.1:${server.port}/snapshot?name=../../etc/evil`, authorized);
    expect(written).toEqual(["/snapshots/evil.heapsnapshot"]);
  });

  it("rejects snapshot requests without a name, saying what was missing", async () => {
    server = await startControlServer({ snapshotDir: "/unused", token });
    const response = await fetch(`http://127.0.0.1:${server.port}/snapshot`, authorized);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("?name=");
  });

  it("returns 404 for unknown paths, naming the path", async () => {
    server = await startControlServer({ snapshotDir: "/unused", token });
    const response = await fetch(`http://127.0.0.1:${server.port}/nope`, authorized);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("/nope");
  });

  // Loopback keeps other machines out, not other processes on this one, and
  // not a page open in a browser here either.
  it("refuses a request that carries no token, before doing any work", async () => {
    const g = globalThis as typeof globalThis & { gc?: () => void };
    const original = g.gc;
    const collect = vi.fn();
    g.gc = collect;
    const written: string[] = [];
    try {
      server = await startControlServer({
        snapshotDir: "/snapshots",
        token,
        writeSnapshot: (file) => {
          written.push(file);
          return file;
        },
      });
      for (const pathname of ["/gc", "/mem", "/snapshot?name=baseline", "/nope"]) {
        const response = await fetch(`http://127.0.0.1:${server.port}${pathname}`);
        expect(response.status, pathname).toBe(403);
        const body = (await response.json()) as Record<string, unknown>;
        expect(Object.keys(body), pathname).toEqual(["error"]);
        expect(body["error"]).toContain(CONTROL_TOKEN_HEADER);
      }
      expect(collect).not.toHaveBeenCalled();
      expect(written).toEqual([]);
    } finally {
      if (original === undefined) {
        delete g.gc;
      } else {
        g.gc = original;
      }
    }
  });

  it("refuses a token that is wrong, whatever its length", async () => {
    server = await startControlServer({ snapshotDir: "/unused", token });
    for (const wrong of ["", "test-tokeX", "test-token-and-more", "x"]) {
      const response = await fetch(`http://127.0.0.1:${server.port}/mem`, {
        headers: { [CONTROL_TOKEN_HEADER]: wrong },
      });
      expect(response.status, JSON.stringify(wrong)).toBe(403);
    }
  });

  it("does not start without a token", async () => {
    await expect(startControlServer({ snapshotDir: "/unused", token: "" })).rejects.toThrow(
      /needs a token/
    );
  });
});
