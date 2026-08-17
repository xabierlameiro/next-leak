import type { TrendResult, TrendVerdict } from "./trend.js";

const MB = 1024 * 1024;

export type UnreclaimedRetention = {
  /** Which memory class grew before collection. */
  class: "heap" | "external";
  /** Mean growth per cycle (bytes) of the pre-collection series. */
  growthPerCycle: number;
  /** The same growth normalized to the traffic each cycle served. */
  growthPer1000Requests: number;
};

export type UnreclaimedRetentionInput = {
  /** Trend over the samples taken before any forced collection. */
  unreclaimedTrend: TrendResult;
  /** The route's own verdict, computed from the post-GC series. */
  verdict: TrendVerdict;
  requestsPerCycle: number;
};

/**
 * Whether a route holds memory that a forced GC takes back — and that a
 * production process may never run one often enough to take back.
 *
 * This is the shape of vercel/next.js#96533: the reporter measured 1.16 GB of
 * `arrayBuffers` accumulated over four days against a flat JS heap, and named
 * the mechanism — buffers rooted through a module-scope WeakMap for as long as
 * the params key object stays reachable, on a process whose full GCs are rare.
 * Every number this tool reports is taken after three forced collections, so
 * that class of leak is invisible to the verdict by construction.
 *
 * Deliberately outside the verdict, like the peak-pressure note: `leak` /
 * `stable` / `inconclusive` are statements about what survives collection, and
 * this is a statement about what precedes it.
 *
 * Silent when the route already leaks — the retention is the headline there,
 * and a note repeating it in weaker terms is noise. Silent, too, when the
 * pre-collection series is merely undecided: that series is noisy by nature
 * (nothing has been collected), and only a series that grows on every cycle is
 * worth interrupting a run for.
 */
export function assessUnreclaimedRetention(
  input: UnreclaimedRetentionInput
): UnreclaimedRetention | null {
  if (input.verdict === "leak" || input.unreclaimedTrend.verdict !== "leak") {
    return null;
  }
  const growthPerCycle = input.unreclaimedTrend.growthPerCycle;
  if (growthPerCycle <= 0 || input.requestsPerCycle <= 0) {
    return null;
  }
  return {
    class: input.unreclaimedTrend.source === "external" ? "external" : "heap",
    growthPerCycle,
    growthPer1000Requests: (growthPerCycle / input.requestsPerCycle) * 1000,
  };
}

const mb = (bytes: number): string => `${(bytes / MB).toFixed(2)} MB`;

/**
 * One line, phrased so it never contradicts the verdict next to it, and so it
 * states its own limit: this reading is taken seconds after load, not the hours
 * a production process runs between full collections.
 */
export function describeUnreclaimedRetention(retention: UnreclaimedRetention): string {
  const where = retention.class === "external" ? "external memory" : "heap";
  return (
    `${where} grew ${mb(retention.growthPer1000Requests)}/1000 req before collection ` +
    `while staying flat after it — a forced GC reclaims this, a long-running ` +
    `process may not run one often enough to; read seconds after load, so it ` +
    `also includes memory not yet collected`
  );
}
