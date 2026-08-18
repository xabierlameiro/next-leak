import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type ProcessRow = {
  pid: number;
  ppid: number;
  /** Resident set size in bytes. `ps` reports KB; converted once, here. */
  rssBytes: number;
  command: string;
};

/**
 * A build's static-generation worker, as spawned by Next.
 *
 * Next runs these through jest-worker, and `experimental.workerThreads`
 * defaults to false — so they are real child processes with their own PID and
 * their own resident memory, which is the whole reason a build is measurable
 * from outside without instrumenting anyone's code. A worker thread would have
 * neither.
 */
const STATIC_WORKER_MARKER = "jest-worker/processChild";
// Next vendors jest-worker, so the real command ends in
// `next/dist/compiled/jest-worker/processChild.js` — matching the tail rather
// than the full path keeps this working if the vendoring path moves again.

const KB = 1024;

/**
 * Parses `ps -axo pid,ppid,rss,command` output.
 *
 * Columns are right-aligned to widths that vary with the values, and the
 * command itself contains spaces — so the first three fields are split off and
 * everything after them is the command. A line that does not start with three
 * numbers is not a process row (the header, or a wrapped line) and is skipped
 * rather than failing the sample.
 */
export function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match === null) {
      continue;
    }
    const [, pid, ppid, rssKb, command] = match;
    if (pid === undefined || ppid === undefined || rssKb === undefined || command === undefined) {
      continue;
    }
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rssBytes: Number(rssKb) * KB,
      command,
    });
  }
  return rows;
}

/**
 * Every process below `rootPid`, at any depth, excluding the root itself.
 *
 * Walks generation by generation rather than recursing per row: a build tree is
 * shallow but the machine's process table is not, and this visits each row once
 * per generation instead of once per ancestor.
 */
export function descendantsOf(rows: readonly ProcessRow[], rootPid: number): ProcessRow[] {
  const found = new Map<number, ProcessRow>();
  let frontier = new Set<number>([rootPid]);
  while (frontier.size > 0) {
    const next = new Set<number>();
    for (const row of rows) {
      if (!frontier.has(row.ppid) || found.has(row.pid) || row.pid === rootPid) {
        continue;
      }
      found.set(row.pid, row);
      next.add(row.pid);
    }
    frontier = next;
  }
  return [...found.values()];
}

/** Whether a row is one of the build's static-generation workers. */
export function isStaticGenWorker(row: ProcessRow): boolean {
  return row.command.includes(STATIC_WORKER_MARKER);
}

export type ProcessTableSample =
  | { ok: true; rows: ProcessRow[] }
  | { ok: false; reason: string };

/**
 * One sample of the whole process table.
 *
 * The failure is reported rather than swallowed. An empty table and an
 * unreadable one look identical downstream — both yield no workers — and
 * reporting "nothing to measure" when the truth is "could not look" is the
 * silent false negative this tool exists to avoid. Seen for real: a sandbox
 * that denies `ps` turned a leaking build into a clean run.
 */
export async function sampleProcessTable(): Promise<ProcessTableSample> {
  try {
    const { stdout } = await run("ps", ["-axo", "pid,ppid,rss,command"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, rows: parseProcessTable(stdout) };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
