import { mkdtemp, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { explainStartupFailure, launchInstrumented, type LaunchedApp } from "./launcher.js";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const bootstrapPath = path.join(rootDir, "dist", "bootstrap.js");
const fakeServer = fileURLToPath(new URL("./__fixtures__/fake-standalone-server.js", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

let app: LaunchedApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("launchInstrumented", () => {
  it("boots the server with a working control channel, then tears it down", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "next-leak-launch-"));
    app = await launchInstrumented({
      serverPath: fakeServer,
      workDir,
      appPort: await freePort(),
      bootstrapPath,
    });

    const appResponse = await fetch(`http://127.0.0.1:${app.appPort}/`);
    expect(((await appResponse.json()) as { ok: boolean }).ok).toBe(true);

    // GC really is exposed in the child (--expose-gc).
    const gc = await fetch(`http://127.0.0.1:${app.controlPort}/gc`);
    const gcBody = (await gc.json()) as { gcExposed: boolean; heapUsed: number };
    expect(gcBody.gcExposed).toBe(true);
    expect(gcBody.heapUsed).toBeGreaterThan(0);

    // A real heap snapshot lands in the work dir.
    const snapshot = await fetch(`http://127.0.0.1:${app.controlPort}/snapshot?name=probe`);
    const snapshotBody = (await snapshot.json()) as { file: string };
    expect(snapshotBody.file).toBe(path.join(workDir, "probe.heapsnapshot"));
    const stats = await stat(snapshotBody.file);
    expect(stats.size).toBeGreaterThan(100_000);

    const port = app.appPort;
    await app.close();
    app = undefined;
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  }, 30_000);

  it("fails with the child's stderr when the server crashes on boot", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "next-leak-launch-"));
    await expect(
      launchInstrumented({
        serverPath: path.join(workDir, "does-not-exist.js"),
        workDir,
        appPort: await freePort(),
        bootstrapPath,
      })
    ).rejects.toMatchObject({ name: "LaunchError" });
  }, 30_000);
});

// Hit while validating webpack builds: a standalone bundle shipped without
// @swc/helpers. The tool was the messenger; the message was a stack dump.
describe("explainStartupFailure", () => {
  it("turns a missing dependency into an actionable sentence", () => {
    const message = explainStartupFailure(
      "Error: Cannot find module '@swc/helpers/_/_interop_require_default'\n  at ..."
    );
    expect(message).toContain("@swc/helpers/_/_interop_require_default");
    expect(message).toContain("build problem, not a measurement one");
    expect(message).not.toContain("at ...");
  });

  it("names a port clash plainly", () => {
    expect(explainStartupFailure("listen EADDRINUSE 127.0.0.1:3000")).toContain("port was taken");
  });

  it("falls back to the raw stderr when the cause is unknown", () => {
    expect(explainStartupFailure("something odd happened")).toContain("something odd happened");
  });
});
