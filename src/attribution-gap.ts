import type { MeasuredRoute } from "./run-types.js";

export type AttributionGapReason = NonNullable<MeasuredRoute["attributionGap"]>["reason"];

/** Why a measured route has no attribution, as one clause. */
export function gapCause(reason: AttributionGapReason): string {
  switch (reason) {
    case "snapshot-unavailable":
      return "the final heap snapshot was never taken";
    case "snapshot-unreadable":
      return "the heap snapshots could not be read";
    case "interrupted":
      return "the run was interrupted before the heap snapshots were compared (both are on disk)";
  }
}

/** The same, for a sentence about several routes at once. */
export function gapCauseOfMany(reasons: readonly AttributionGapReason[]): string {
  const phrase: Record<AttributionGapReason, string> = {
    "snapshot-unavailable": "their final snapshot could not be taken",
    "snapshot-unreadable": "their snapshot could not be read",
    interrupted: "the run was interrupted before their snapshots were compared",
  };
  return [...new Set(reasons)].map((reason) => phrase[reason]).join(", or ");
}
