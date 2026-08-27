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

    // Synthetic nodes are V8's scaffolding — the unnamed root, (GC roots),
    // (Global handles). They name nothing and their retained size counts
    // everything below them, so the root's delta is simply the heap's growth
    // and it outranks every real object. Measuring vercel/next.js#94919 put
    // `grown [synthetic] 1755.4 MB` at the top of a route whose heap grew
    // 39 → 162 MB, with the one named object third. The chain walker already
    // steps around these; findings must too.
    if (node.type === "synthetic") {
      return;
    }

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
  /**
   * Bytes that had to fit in one string, when that is why the snapshot was
   * refused. Carried on the error so the caller — which knows the load that
   * produced it — can work out what would have fit.
   */
  readonly parsedBytes?: number;

  constructor(message: string, parsedBytes?: number) {
    super(message);
    this.name = "SnapshotError";
    if (parsedBytes !== undefined) {
      this.parsedBytes = parsedBytes;
    }
  }
}

const SNAPSHOT_HEAD = '{"snapshot"';
const PROBE_BYTES = 512;

/**
 * Top-level keys of a V8 heap snapshot, in the order V8 writes them.
 *
 * The order is what makes scanning for them safe. `strings` holds arbitrary
 * program text that can imitate any of these keys, and it comes last, so the
 * first occurrence of each one is always the real key. `snapshot.meta` carries
 * `node_fields` and `edge_types`, never `"nodes":` or `"edges":`.
 */
const SNAPSHOT_SECTIONS = [
  "snapshot",
  "nodes",
  "edges",
  "trace_function_infos",
  "trace_tree",
  "samples",
  "locations",
  "strings",
] as const;

/**
 * Sections memlab pulls out as typed arrays rather than parsing as JSON.
 *
 * `HeapParser.parseFile` reads these three through `StringLoader` in chunks
 * and calls `JSON.parse` only on what is left, so their bytes never have to
 * fit in a string however many of them there are.
 */
const TYPED_ARRAY_SECTIONS: ReadonlySet<string> = new Set(["nodes", "edges", "locations"]);

/** Reading granularity for the section scan. */
const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0);

/**
 * How many bytes of a snapshot memlab actually has to hold in one string.
 *
 * Null when the file does not look like the layout above, in which case the
 * caller falls back to judging it by its total size — what this tool did for
 * every snapshot before it was measured that the two are wildly different: on
 * a 1342.9 MB snapshot of a leaking route, 1340.5 MB were `nodes` and `edges`
 * and 2.4 MB reached `JSON.parse`. Refusing that one cost the attribution on
 * the worst leak in the run.
 */
export async function parsedSectionBytes(file: string, fileSize: number): Promise<number | null> {
  const { createReadStream } = await import("node:fs");

  const offsets = new Map<string, number>();
  let scanned = 0;
  let carry = "";
  const longestKey = Math.max(...SNAPSHOT_SECTIONS.map((key) => key.length)) + 3;

  const stream = createReadStream(file, {
    encoding: "latin1",
    highWaterMark: SCAN_CHUNK_BYTES,
  });
  try {
    for await (const chunk of stream) {
      const text = carry + (chunk as string);
      const base = scanned - carry.length;
      for (const key of SNAPSHOT_SECTIONS) {
        if (offsets.has(key)) {
          continue;
        }
        const at = text.indexOf(`"${key}":`);
        if (at !== -1) {
          offsets.set(key, base + at);
        }
      }
      scanned += (chunk as string).length;
      // `strings` is last, so everything is located once it is found.
      if (offsets.has("strings")) {
        break;
      }
      // `nodes` and `edges` are the second and third keys V8 writes, after a
      // `meta` block of a few hundred bytes. Absent from the first chunk, this
      // is not a snapshot laid out the way the scan assumes, and reading the
      // rest of a multi-gigabyte file to confirm that helps nobody.
      if (!offsets.has("nodes") || !offsets.has("edges")) {
        return null;
      }
      carry = text.slice(-longestKey);
    }
  } finally {
    stream.destroy();
  }

  const located = SNAPSHOT_SECTIONS.filter((key) => offsets.has(key)).map((key) => ({
    key,
    at: offsets.get(key) ?? 0,
  }));
  const typedFound = located.filter((section) => TYPED_ARRAY_SECTIONS.has(section.key));
  const ascending = located.every(
    (section, index) => index === 0 || section.at > (located[index - 1]?.at ?? 0)
  );
  if (typedFound.length !== TYPED_ARRAY_SECTIONS.size || !ascending) {
    return null;
  }

  let typedBytes = 0;
  for (const [index, section] of located.entries()) {
    if (!TYPED_ARRAY_SECTIONS.has(section.key)) {
      continue;
    }
    const end = located[index + 1]?.at ?? fileSize;
    typedBytes += end - section.at;
  }
  return fileSize - typedBytes;
}

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
  const { constants } = await import("node:buffer");
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    throw new SnapshotError(`heap snapshot is missing: ${file}`);
  }
  if (size === 0) {
    throw new SnapshotError(`heap snapshot is empty: ${file}`);
  }
  // Part of a snapshot is parsed by reading it into one string, and V8 caps a
  // string at 512 MB. Past that the read dies with `RangeError: Invalid string
  // length` from inside node:fs, which no amount of care in this file
  // prevents — so refuse before the attempt and say what happened. Measured
  // 2026-08-18 on the vercel/next.js#97424 reproduction: the second pass wrote
  // a 1.7 GB baseline and the whole run died at the diff, taking a completed
  // measurement with it.
  //
  // Which part matters. memlab reads `nodes`, `edges` and `locations` as typed
  // arrays in chunks and parses only the rest, and on a leaking snapshot the
  // rest is almost nothing: 2.4 MB of 1342.9 MB, measured 2026-08-27. Judging
  // the file refused diffs memlab would have completed, and it refused them
  // hardest on the biggest leaks — the runs where naming the retainer is worth
  // the most. When the scan cannot make sense of the layout it returns null
  // and the file size decides, which is where this started.
  // Only worth scanning when the file alone would be refused: below the
  // ceiling every section is below it too, and the scan would be a sequential
  // read bought for nothing.
  const parsedBytes =
    size > constants.MAX_STRING_LENGTH ? await parsedSectionBytes(file, size) : size;
  const judged = parsedBytes ?? size;
  if (judged > constants.MAX_STRING_LENGTH) {
    const scope =
      parsedBytes === null
        ? `heap snapshot is ${mb(size)} MB`
        : `heap snapshot parses ${mb(parsedBytes)} MB of its ${mb(size)} MB`;
    throw new SnapshotError(
      `${scope}, past the ${mb(constants.MAX_STRING_LENGTH)} MB a single string can ` +
        `hold, so it cannot be parsed: ${file}. The measurement itself is unaffected — ` +
        `only the snapshot diff, which names the retaining object, is unavailable. ` +
        `Lower --requests or --cycles to keep the heap smaller if you need it`,
      judged
    );
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
