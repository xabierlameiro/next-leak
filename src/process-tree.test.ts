import { describe, expect, it } from "vitest";
import { descendantsOf, isStaticGenWorker, parseProcessTable } from "./process-tree.js";

// Real `ps -axo pid,ppid,rss,command` output, trimmed to the build's own
// processes, captured while reproducing vercel/next.js#97464 on 16.3.1.
const REAL_PS_OUTPUT = `  PID  PPID    RSS COMMAND
    1     0  17488 /sbin/launchd
97103 95996   2976 /bin/zsh -c npm run build
97107 97103  49216 npm run build
97131 97107 337408 next-build (v16.3.1)
97155 97131 2955264 /Users/x/.nvm/versions/node/v24.18.0/bin/node /repo/node_modules/next/dist/compiled/jest-worker/processChild.js
`;

describe("parseProcessTable", () => {
  it("reads pid, parent and command from real ps output", () => {
    const rows = parseProcessTable(REAL_PS_OUTPUT);
    const worker = rows.find((row) => row.pid === 97155);

    expect(worker?.ppid).toBe(97131);
    expect(worker?.command).toContain("processChild.js");
  });

  it("converts ps kilobytes into bytes", () => {
    const rows = parseProcessTable(REAL_PS_OUTPUT);
    const worker = rows.find((row) => row.pid === 97155);

    // 2955264 KB is the ~2.8 GiB the worker had reached before it died.
    expect(worker?.rssBytes).toBe(2_955_264 * 1024);
  });

  it("skips the header instead of reading it as a process", () => {
    const rows = parseProcessTable(REAL_PS_OUTPUT);
    expect(rows.every((row) => Number.isInteger(row.pid))).toBe(true);
    expect(rows).toHaveLength(5);
  });

  it("keeps commands that contain spaces whole", () => {
    const rows = parseProcessTable(REAL_PS_OUTPUT);
    expect(rows.find((row) => row.pid === 97107)?.command).toBe("npm run build");
  });

  it("skips malformed lines rather than failing the sample", () => {
    const rows = parseProcessTable("  PID  PPID    RSS COMMAND\nnot a row at all\n42 1 100 node\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pid).toBe(42);
  });

  it("returns nothing for empty output", () => {
    expect(parseProcessTable("")).toEqual([]);
  });
});

describe("descendantsOf", () => {
  const rows = parseProcessTable(REAL_PS_OUTPUT);

  it("finds a worker nested below the launched process", () => {
    // Launching `npm run build` puts two processes between us and the worker.
    const descendants = descendantsOf(rows, 97107).map((row) => row.pid);
    expect(descendants).toContain(97131);
    expect(descendants).toContain(97155);
  });

  it("excludes the root itself", () => {
    expect(descendantsOf(rows, 97107).map((row) => row.pid)).not.toContain(97107);
  });

  it("returns nothing for a process with no children", () => {
    expect(descendantsOf(rows, 97155)).toEqual([]);
  });

  it("does not walk upwards", () => {
    expect(descendantsOf(rows, 97131).map((row) => row.pid)).toEqual([97155]);
  });

  it("survives a cycle in the table without hanging", () => {
    // Not expected from a real kernel, but a self-parenting row must not spin.
    const cyclic = parseProcessTable("10 11 100 a\n11 10 100 b\n");
    expect(descendantsOf(cyclic, 10).map((row) => row.pid)).toEqual([11]);
  });
});

describe("isStaticGenWorker", () => {
  const rows = parseProcessTable(REAL_PS_OUTPUT);

  it("recognises the jest-worker child Next spawns for static generation", () => {
    const worker = rows.find((row) => row.pid === 97155);
    expect(worker !== undefined && isStaticGenWorker(worker)).toBe(true);
  });

  it("does not mistake the build parent for a worker", () => {
    // The parent sheds memory while the worker climbs: counting it as a worker
    // would cancel the finding out.
    const parent = rows.find((row) => row.pid === 97131);
    expect(parent !== undefined && isStaticGenWorker(parent)).toBe(false);
  });
});
