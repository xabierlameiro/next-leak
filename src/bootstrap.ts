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
import { countServedRequests } from "./request-probe.js";

const workDir = process.env["NEXT_LEAK_DIR"];

/**
 * Counts the requests the host app serves, so the run record shows how much
 * traffic reached the process each sample came from. Installed after the
 * control server is listening, so the control channel's own traffic is not
 * counted.
 *
 * Evidence, not a gate: a clustered server counts in whichever process took the
 * connection, so a zero here does not by itself mean the wrong process was
 * sampled. Recording it is what made the difference in the vercel/next.js#99077
 * investigation, where establishing it by hand cost a full pass.
 */
function installRequestProbe(): void {
  requestProbe.__nextLeakServedRequests = 0;
  countServedRequests(http);
  countServedRequests(https);
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
