/**
 * Entry loaded into the measured app's process via `node --import`. Boots the
 * internal control channel and announces its port by writing `control.json`
 * into `$NEXT_LEAK_DIR`. Inert when the env var is absent, and never breaks
 * the host app: failures are logged to stderr only.
 */
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { requestProbe, startControlServer } from "./control-server.js";

const workDir = process.env["NEXT_LEAK_DIR"];

/**
 * Counts the requests the host app serves, so every sample can prove it came
 * from the process actually under load rather than from a sibling that happens
 * to answer the control channel. Installed after the control server is
 * listening, so the control channel's own traffic is not counted.
 */
function installRequestProbe(): void {
  requestProbe.__nextLeakServedRequests = 0;
  for (const module of [http, https] as { createServer: typeof http.createServer }[]) {
    const original = module.createServer;
    module.createServer = function patched(
      this: unknown,
      ...args: Parameters<typeof http.createServer>
    ): ReturnType<typeof http.createServer> {
      const server = original.apply(this, args);
      server.on("request", () => {
        requestProbe.__nextLeakServedRequests = (requestProbe.__nextLeakServedRequests ?? 0) + 1;
      });
      return server;
    } as typeof http.createServer;
  }
}

if (workDir !== undefined && workDir !== "") {
  try {
    await mkdir(workDir, { recursive: true });
    const server = await startControlServer({ snapshotDir: workDir });
    installRequestProbe();
    // One file per process, not a single shared one: `next start` (and any
    // clustered server) loads this bootstrap into several processes, and a
    // shared file left the last writer winning — often a process that was
    // not the one serving requests.
    await writeFile(
      path.join(workDir, `control-${process.pid}.json`),
      JSON.stringify({ port: server.port, pid: process.pid })
    );
  } catch (cause) {
    console.error(`[next-leak] control channel failed to start: ${String(cause)}`);
  }
}
