import type { HeapDiff, NodeFinding } from "./heap-diff.js";

/**
 * Share of a container's growth a held finding must account for before the
 * container stops being worth naming on its own.
 *
 * Measured on two reproductions. vercel/next.js#100492 (16.4.6): `global`,
 * an `Object` and a `system / Context` each held the next at 99.9% of its
 * bytes, down to the `LRUCache` that was the only one with an owner.
 * vercel/next.js#99335: Next's server context (3.32 MB) held fsChecker
 * (3.32 MB), which held its LRU's table (0.92 MB, 28%) — the first pair is one
 * store, the second is a container with plenty of its own.
 */
export const SPECIFIC_SHARE = 0.9;

export type ShownFinding = {
  finding: NodeFinding;
  /** Position in `[...grownNodes, ...newNodes]`, which attribution is aligned with. */
  index: number;
  /** Findings around this one that were folded into it, because it explains them. */
  enclosing: number;
};

/**
 * The findings a report should name, most specific first.
 *
 * Findings are kept in size order, and a container is always at least as big
 * as what it holds, so the order put the wrappers first and the store they
 * wrap last — on #100492 fourth, one place past what the terminal shows. A
 * container whose growth is almost all one held finding is replaced by it,
 * following the chain to the innermost. Everything else keeps its place.
 */
export function shownFindings(diff: Pick<HeapDiff, "grownNodes" | "newNodes">): ShownFinding[] {
  const all = [...diff.grownNodes, ...diff.newNodes];
  const indexById = new Map<number, number>();
  for (const [index, finding] of all.entries()) {
    if (finding.nodeId !== undefined) {
      indexById.set(finding.nodeId, index);
    }
  }

  // For each container, the largest held finding that explains it. A tie keeps
  // the first in size order.
  const explainedBy: Array<number | undefined> = all.map(() => undefined);
  for (const [index, finding] of all.entries()) {
    const holder = indexById.get(finding.containedIn ?? Number.NaN);
    const container = holder === undefined ? undefined : all[holder];
    if (
      holder === undefined ||
      container === undefined ||
      finding.retainedBytes < container.retainedBytes * SPECIFIC_SHARE
    ) {
      continue;
    }
    const best = all[explainedBy[holder] ?? -1];
    if (best === undefined || finding.retainedBytes > best.retainedBytes) {
      explainedBy[holder] = index;
    }
  }

  const shown: ShownFinding[] = [];
  const named = new Set<number>();
  for (const index of all.keys()) {
    let representative = index;
    let enclosing = 0;
    const visited = new Set<number>([index]);
    for (
      let next = explainedBy[representative];
      next !== undefined && !visited.has(next);
      next = explainedBy[representative]
    ) {
      visited.add(next);
      representative = next;
      enclosing += 1;
    }
    const finding = all[representative];
    if (finding === undefined || named.has(representative)) {
      continue;
    }
    named.add(representative);
    shown.push({ finding, index: representative, enclosing });
  }
  return shown;
}

/** How many findings around this one hold the same bytes, when any were folded in. */
export function enclosingNote(enclosing: number): string {
  if (enclosing === 0) {
    return "";
  }
  const subject = enclosing === 1 ? "1 finding around it holds" : `${enclosing} findings around it hold`;
  return ` · ${subject} the same bytes`;
}
