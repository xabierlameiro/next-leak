import { config as memlabConfig } from "@memlab/core";
import { getFullHeapFromFile } from "@memlab/heap-analysis";

/**
 * Minimal structural view of a parsed heap snapshot. `@memlab`'s
 * IHeapSnapshot satisfies it; tests use small hand-built graphs.
 */
export type HeapEdgeLike = {
  type: string;
  name_or_index: string | number;
  fromNode: HeapNodeLike;
};

export type HeapNodeLike = {
  id: number;
  type: string;
  name: string;
  self_size: number;
  retainedSize: number;
  referrers: HeapEdgeLike[];
  /** Outgoing edges; optional because test fixtures rarely need them. */
  references?: Array<{ name_or_index: string | number }>;
};

export type HeapLike = {
  nodes: { forEach(callback: (node: HeapNodeLike) => void): void };
};

export type DiffOptions = {
  /** Type-level deltas smaller than this are dropped. Default 20 KiB. */
  minTypeDeltaBytes?: number;
  /** Retained-size growth for an existing node to be reported. Default 100 KiB. */
  grownThresholdBytes?: number;
  /** Retained size for a new node to be considered. Default 2 KiB. */
  newThresholdBytes?: number;
  /**
   * Baseline nodes with retained size below this floor are not tracked for
   * growth — the memory guard that keeps the baseline summary small.
   * Default 50 KiB.
   */
  bigRetainedFloorBytes?: number;
  maxFindings?: number;
  chainDepth?: number;
};

type ResolvedOptions = Required<DiffOptions>;

const DEFAULTS: ResolvedOptions = {
  minTypeDeltaBytes: 20 * 1024,
  grownThresholdBytes: 100 * 1024,
  newThresholdBytes: 2 * 1024,
  bigRetainedFloorBytes: 50 * 1024,
  maxFindings: 10,
  chainDepth: 7,
};

export type TypeDelta = { type: string; deltaBytes: number };

export type NodeFinding = {
  kind: "grown" | "new";
  nodeType: string;
  name: string;
  /** Retained-size delta for grown nodes; absolute retained size for new ones. */
  retainedBytes: number;
  retainerChain: string;
  /** Bundler module ids seen along the chain (needs `resolveNumeric`). */
  moduleIds: number[];
};

export type HeapDiff = {
  typeDeltas: TypeDelta[];
  grownNodes: NodeFinding[];
  newNodes: NodeFinding[];
};

/**
 * Compact summary of a baseline heap. This is all that stays resident after
 * the baseline snapshot is parsed — never the heap itself.
 */
export type BaselineSummary = {
  nodeIds: Set<number>;
  bigRetained: Map<number, number>;
  typeSelfSizes: Map<string, number>;
};

export function summarizeBaseline(
  heap: HeapLike,
  options: DiffOptions = {}
): BaselineSummary {
  const resolved = { ...DEFAULTS, ...options };
  const summary: BaselineSummary = {
    nodeIds: new Set(),
    bigRetained: new Map(),
    typeSelfSizes: new Map(),
  };
  heap.nodes.forEach((node) => {
    summary.nodeIds.add(node.id);
    if (node.retainedSize >= resolved.bigRetainedFloorBytes) {
      summary.bigRetained.set(node.id, node.retainedSize);
    }
    summary.typeSelfSizes.set(
      node.type,
      (summary.typeSelfSizes.get(node.type) ?? 0) + node.self_size
    );
  });
  return summary;
}

function truncateLabel(value: string, max = 60): string {
  return value.replaceAll("\n", " ").slice(0, max);
}

function walkChain(
  node: HeapNodeLike,
  depth: number
): { parts: string[]; nodes: HeapNodeLike[] } {
  const parts: string[] = [];
  const nodes: HeapNodeLike[] = [node];
  let current = node;
  const seen = new Set<number>([node.id]);
  for (let i = 0; i < depth; i += 1) {
    const referrers = current.referrers;
    if (referrers.length === 0) {
      break;
    }
    const edge =
      referrers.find(
        (candidate) =>
          !seen.has(candidate.fromNode.id) &&
          candidate.fromNode.type !== "synthetic" &&
          candidate.type !== "weak"
      ) ?? referrers[0];
    if (edge === undefined || seen.has(edge.fromNode.id)) {
      break;
    }
    current = edge.fromNode;
    seen.add(current.id);
    nodes.push(current);
    parts.push(
      `${truncateLabel(current.name)}#${current.type}[.${truncateLabel(
        String(edge.name_or_index),
        40
      )}]`
    );
  }
  return { parts, nodes };
}

/**
 * Walks referrers upward preferring strong, non-synthetic edges and refusing
 * to revisit nodes, producing a single human-readable ownership chain.
 */
export function retainerChain(node: HeapNodeLike, depth: number): string {
  return walkChain(node, depth).parts.join(" <- ");
}

/**
 * Harvests bundler module ids from the chain. A Turbopack module instance is
 * recognizable by its `namespaceObject`/`exports` properties, and the module
 * cache retains each instance through an element edge **named with the real
 * module id** (the hash-slot edge from the cache's backing store carries a
 * meaningless index — verified empirically in phase 2's spike).
 */
function collectModuleIds(chainNodes: HeapNodeLike[]): number[] {
  const ids: number[] = [];
  for (const node of chainNodes) {
    const isModuleInstance = (node.references ?? []).some(
      (edge) => edge.name_or_index === "namespaceObject" || edge.name_or_index === "exports"
    );
    if (!isModuleInstance) {
      continue;
    }
    for (const edge of node.referrers) {
      if (edge.type !== "element") {
        continue;
      }
      const id = Number(edge.name_or_index);
      if (Number.isInteger(id) && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

export function diffAgainstBaseline(
  baseline: BaselineSummary,
  after: HeapLike,
  options: DiffOptions = {}
): HeapDiff {
  const resolved = { ...DEFAULTS, ...options };

  const afterTypeSelfSizes = new Map<string, number>();
  const grown: NodeFinding[] = [];
  const fresh: NodeFinding[] = [];

  after.nodes.forEach((node) => {
    afterTypeSelfSizes.set(
      node.type,
      (afterTypeSelfSizes.get(node.type) ?? 0) + node.self_size
    );

    if (!baseline.nodeIds.has(node.id)) {
      if (node.retainedSize >= resolved.newThresholdBytes) {
        const chain = walkChain(node, resolved.chainDepth);
        fresh.push({
          kind: "new",
          nodeType: node.type,
          name: truncateLabel(node.name),
          retainedBytes: node.retainedSize,
          retainerChain: chain.parts.join(" <- "),
          moduleIds: collectModuleIds(chain.nodes),
        });
      }
      return;
    }

    const before = baseline.bigRetained.get(node.id);
    if (before !== undefined && node.retainedSize - before >= resolved.grownThresholdBytes) {
      const chain = walkChain(node, resolved.chainDepth);
      grown.push({
        kind: "grown",
        nodeType: node.type,
        name: truncateLabel(node.name),
        retainedBytes: node.retainedSize - before,
        retainerChain: chain.parts.join(" <- "),
        moduleIds: collectModuleIds(chain.nodes),
      });
    }
  });

  const typeDeltas: TypeDelta[] = [];
  const allTypes = new Set([...baseline.typeSelfSizes.keys(), ...afterTypeSelfSizes.keys()]);
  for (const type of allTypes) {
    const delta = (afterTypeSelfSizes.get(type) ?? 0) - (baseline.typeSelfSizes.get(type) ?? 0);
    if (Math.abs(delta) >= resolved.minTypeDeltaBytes) {
      typeDeltas.push({ type, deltaBytes: delta });
    }
  }
  typeDeltas.sort((a, b) => b.deltaBytes - a.deltaBytes);
  grown.sort((a, b) => b.retainedBytes - a.retainedBytes);
  fresh.sort((a, b) => b.retainedBytes - a.retainedBytes);

  return {
    typeDeltas,
    grownNodes: grown.slice(0, resolved.maxFindings),
    newNodes: fresh.slice(0, resolved.maxFindings),
  };
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

const SNAPSHOT_HEAD = '{"snapshot"';
const PROBE_BYTES = 512;

/**
 * Cheap structural check before handing a file to memlab.
 *
 * memlab does not throw on malformed input — it calls `process.exit(1)`,
 * which no try/catch can intercept. Without this guard a truncated snapshot
 * (disk full, process killed mid-write) killed the CLI outright and took a
 * multi-hour run's results with it. Reads O(1) bytes, not the whole file.
 */
export async function assertReadableSnapshot(file: string): Promise<void> {
  const { open, stat } = await import("node:fs/promises");
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    throw new SnapshotError(`heap snapshot is missing: ${file}`);
  }
  if (size === 0) {
    throw new SnapshotError(`heap snapshot is empty: ${file}`);
  }

  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(Math.min(PROBE_BYTES, size));
    await handle.read(head, 0, head.length, 0);
    if (!head.toString("utf8").trimStart().startsWith(SNAPSHOT_HEAD)) {
      throw new SnapshotError(
        `not a V8 heap snapshot (missing "snapshot" header): ${file}`
      );
    }
    const tail = Buffer.alloc(Math.min(PROBE_BYTES, size));
    await handle.read(tail, 0, tail.length, size - tail.length);
    if (!tail.toString("utf8").trimEnd().endsWith("}")) {
      throw new SnapshotError(
        `heap snapshot looks truncated (JSON does not close): ${file} — ` +
          `the measured process may have been killed while writing it`
      );
    }
  } finally {
    await handle.close();
  }
}

export type HeapLoader = (file: string) => Promise<HeapLike>;

const defaultLoader: HeapLoader = async (file) => {
  // Guard before memlab sees the file: it exits the process on malformed
  // input instead of throwing (see assertReadableSnapshot).
  await assertReadableSnapshot(file);
  // memlab prints parser progress to stderr; keep tool output clean.
  memlabConfig.muteConsole = true;
  return getFullHeapFromFile(file);
};

/**
 * Diffs two snapshot files parsing them strictly sequentially: the baseline
 * heap is reduced to its compact summary and released before the after heap
 * is parsed, so at most one full heap graph is resident at any time.
 */
export async function diffSnapshotFiles(
  baselineFile: string,
  afterFile: string,
  options: DiffOptions = {},
  loadHeap: HeapLoader = defaultLoader
): Promise<HeapDiff> {
  const summary = summarizeBaseline(await loadHeap(baselineFile), options);
  const after = await loadHeap(afterFile);
  return diffAgainstBaseline(summary, after, options);
}
