import { afterEach, describe, expect, it } from "vitest";
import { forceGc, startControlServer, type ControlServer } from "./control-server.js";

let server: ControlServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("forceGc", () => {
  it("reports whether GC is exposed instead of throwing", async () => {
    // Vitest does not run with --expose-gc by default; either outcome is
    // valid, but it must never throw.
    await expect(forceGc()).resolves.toBeTypeOf("boolean");
  });
});

describe("startControlServer", () => {
  it("serves memory samples on /gc", async () => {
    server = await startControlServer({ snapshotDir: "/unused" });
    const response = await fetch(`http://127.0.0.1:${server.port}/gc`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["heapUsed"]).toBeTypeOf("number");
    expect(body["rss"]).toBeTypeOf("number");
    expect(body["gcExposed"]).toBeTypeOf("boolean");
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

  it("rejects snapshot requests without a name", async () => {
    server = await startControlServer({ snapshotDir: "/unused" });
    const response = await fetch(`http://127.0.0.1:${server.port}/snapshot`);
    expect(response.status).toBe(400);
  });

  it("returns 404 for unknown paths", async () => {
    server = await startControlServer({ snapshotDir: "/unused" });
    const response = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(response.status).toBe(404);
  });
});

describe("control server lifecycle", () => {
  it("does not keep the host process alive", async () => {
    // Found while probing Node 24.4: an open control socket kept the measured
    // process running forever. Measuring must not change what is measured.
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const pathModule = await import("node:path");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");

    const rootDir = fileURLToPath(new URL("..", import.meta.url));
    const workDir = await mkdtemp(pathModule.join(tmpdir(), "next-leak-unref-"));
    const started = Date.now();
    execFileSync(
      process.execPath,
      ["--import", `file://${pathModule.join(rootDir, "dist", "bootstrap.js")}`, "-e", "0"],
      { env: { ...process.env, NEXT_LEAK_DIR: workDir }, timeout: 20_000 }
    );
    // Without unref() this never returns.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it("announces one control file per process id", async () => {
    const { readdir, mkdtemp } = await import("node:fs/promises");
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const pathModule = await import("node:path");
    const { tmpdir } = await import("node:os");

    const rootDir = fileURLToPath(new URL("..", import.meta.url));
    const workDir = await mkdtemp(pathModule.join(tmpdir(), "next-leak-pids-"));
    const bootstrap = `file://${pathModule.join(rootDir, "dist", "bootstrap.js")}`;
    for (let i = 0; i < 2; i += 1) {
      execFileSync(process.execPath, ["--import", bootstrap, "-e", "0"], {
        env: { ...process.env, NEXT_LEAK_DIR: workDir },
        timeout: 20_000,
      });
    }
    const files = (await readdir(workDir)).filter((name) => name.startsWith("control-"));
    // Two processes → two announcements, no overwriting.
    expect(files).toHaveLength(2);
  }, 40_000);
});
