import type { NodeVersionResult } from "./runner.js";

const MIB = 1024 * 1024;

/**
 * How far apart two versions' end-of-run memory must be to count as a
 * difference, as a ratio and as bytes. Both are needed: a 2x gap between 20 and
 * 40 MB is noise on a Next.js server; 64 MiB at 1.1x is a large app's wobble.
 * On the vercel/next.js#97938 reproduction (16.3.6) Node 22.23 held about
 * 750 MB and Node 24.22 under 100, both called `stable`.
 */
export const HELD_RATIO = 2;
export const HELD_FLOOR_BYTES = 64 * MIB;

/** Whether the versions compared tell different stories about this route. */
export function nodeVersionsDiffer(results: readonly NodeVersionResult[]): boolean {
  if (new Set(results.map((result) => result.verdict ?? result.status)).size > 1) {
    return true;
  }
  const held = results
    .map((result) => result.heldBytes)
    .filter((bytes): bytes is number => bytes !== undefined);
  const most = Math.max(...held);
  const least = Math.min(...held);
  return most - least >= HELD_FLOOR_BYTES && most >= least * HELD_RATIO;
}

/** One version's result, as the reports print it. */
export function describeNodeVersion(result: NodeVersionResult): string {
  if (result.verdict === undefined) {
    return `${result.version} ${result.status}`;
  }
  const held =
    result.heldBytes === undefined ? "" : `, holds ${(result.heldBytes / MIB).toFixed(1)} MB`;
  return `${result.version} ${result.verdict}${held}`;
}

/** The comparison in one line, or null when the run compared no versions. */
export function nodeComparisonText(results: readonly NodeVersionResult[] | undefined): string | null {
  if (results === undefined || results.length < 2) {
    return null;
  }
  const versions = results.map(describeNodeVersion).join(" · ");
  return `by Node version: ${versions}${nodeVersionsDiffer(results) ? " — the versions differ" : ""}`;
}
