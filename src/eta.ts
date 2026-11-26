import { formatDuration } from "./format-duration.js";
import type { PhaseTiming } from "./ritual.js";

/**
 * How long the passes still to come should take, read off the passes that
 * already ran.
 *
 * The up-front estimate cannot know the app's throughput and assumes 250
 * requests a second. On the vercel/next.js#97938 slug route (16.3.6, Node 22)
 * the server rendered about 6.5: 300 requests took 46 s a cycle, and a run
 * announced at "26s–47s" took 30 minutes over four passes. Once one pass has
 * run, its own timings are a better price than any constant.
 */

const CYCLE_PHASE = /^cycle (\d+) /;

/** Requests per second over the load phases of one pass, or null without any. */
export function observedThroughput(
  timings: readonly PhaseTiming[],
  requestsPerCycle: number
): number | null {
  const loads = timings.filter(
    (timing) => CYCLE_PHASE.test(timing.phase) && timing.phase.endsWith(" load")
  );
  const seconds = loads.reduce((sum, timing) => sum + timing.seconds, 0);
  // No load phase sums to zero seconds too.
  return seconds <= 0 ? null : (loads.length * requestsPerCycle) / seconds;
}

/**
 * Seconds a pass with `cycles` cycles should take at the pace of `timings`:
 * the phases outside the cycles (warm-up, snapshots) as they were, plus the
 * mean cycle times `cycles`. Null when `timings` has no cycle to go by.
 */
export function passSecondsAt(timings: readonly PhaseTiming[], cycles: number): number | null {
  const cycleNumbers = new Set<string>();
  let cycleSeconds = 0;
  let fixedSeconds = 0;
  for (const timing of timings) {
    const match = CYCLE_PHASE.exec(timing.phase);
    if (match?.[1] === undefined) {
      fixedSeconds += timing.seconds;
    } else {
      cycleNumbers.add(match[1]);
      cycleSeconds += timing.seconds;
    }
  }
  if (cycleNumbers.size === 0) {
    return null;
  }
  return fixedSeconds + (cycleSeconds / cycleNumbers.size) * cycles;
}

/** " (≈ 4m at the pace of the first pass)", or "" when there is no pace to go by. */
export function paceNote(seconds: number | null, basis: string): string {
  return seconds === null ? "" : ` (≈ ${formatDuration(Math.round(seconds))} ${basis})`;
}
