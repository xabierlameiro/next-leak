/**
 * Entry loaded into the measured app's process via `node --import`. Boots the
 * internal control channel and announces its port by writing `control.json`
 * into `$NEXT_LEAK_DIR`. Inert when the env var is absent, and never breaks
 * the host app: failures are logged to stderr only.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startControlServer } from "./control-server.js";

const workDir = process.env["NEXT_LEAK_DIR"];

if (workDir !== undefined && workDir !== "") {
  try {
    await mkdir(workDir, { recursive: true });
    const server = await startControlServer({ snapshotDir: workDir });
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
