import { describe, expect, it } from "vitest";
import {
  assertReadableSnapshot,
  diffAgainstBaseline,
  diffSnapshotFiles,
  retainerChain,
  summarizeBaseline,
  type HeapLike,
  type HeapNodeLike,
} from "./heap-diff.js";

const KB = 1024;

function makeNode(partial: Partial<HeapNodeLike> & { id: number }): HeapNodeLike {
  return {
    type: "object",
    name: "Object",
    self_size: 0,
    retainedSize: 0,
    referrers: [],
    ...partial,
  };
}

function link(from: HeapNodeLike, to: HeapNodeLike, name: string | number, type = "property"): void {
  to.referrers.push({ type, name_or_index: name, fromNode: from });
}

function makeHeap(nodes: HeapNodeLike[]): HeapLike {
  return { nodes: { forEach: (callback) => nodes.forEach(callback) } };
}

const OPTIONS = {
  minTypeDeltaBytes: 1 * KB,
  grownThresholdBytes: 100 * KB,
  newThresholdBytes: 1 * KB,
  bigRetainedFloorBytes: 50 * KB,
};

/**
 * Models the phase-0 leaky scenario: a module-context-owned Array whose
 * retained size grows across snapshots while new concatenated strings appear.
 */
function leakyScenario() {
  const baselineArray = makeNode({ id: 10, name: "Array", self_size: 64, retainedSize: 200 * KB });
  const baselineContext = makeNode({
    id: 1,
    name: "system / Context",
    self_size: 100,
    retainedSize: 300 * KB,
  });
  const baseline = makeHeap([baselineContext, baselineArray]);

  const afterContext = makeNode({
    id: 1,
    name: "system / Context",
    self_size: 100,
    retainedSize: 2000 * KB,
  });
  const afterClosure = makeNode({ id: 2, type: "closure", name: "e", self_size: 50 });
  const afterArray = makeNode({ id: 10, name: "Array", self_size: 64, retainedSize: 1850 * KB });
  link(afterContext, afterArray, "d");
  link(afterClosure, afterContext, "context");
  const strings = [3, 5, 7].map((id, index) =>
    makeNode({
      id: 100 + id,
      type: "concatenated string",
      name: `ua-${index}-zzz`,
      self_size: 2 * KB,
      retainedSize: (3 - index) * 2 * KB,
    })
  );
  for (const [index, stringNode] of strings.entries()) {
    link(afterArray, stringNode, 767 + index, "element");
  }
  const after = makeHeap([afterContext, afterClosure, afterArray, ...strings]);
  return { baseline, after };
}

describe("diffAgainstBaseline", () => {
  it("reports the grown container with its ownership chain (phase-0 shape)", () => {
    const { baseline, after } = leakyScenario();
    const diff = diffAgainstBaseline(summarizeBaseline(baseline, OPTIONS), after, OPTIONS);

    const array = diff.grownNodes.find((finding) => finding.name === "Array");
    expect(array).toBeDefined();
    expect(array?.retainedBytes).toBe(1650 * KB);
    expect(array?.retainerChain).toBe("system / Context#object[.d] <- e#closure[.context]");
    // The context grew too, and more, so it sorts first.
    expect(diff.grownNodes[0]?.name).toBe("system / Context");
  });

  it("reports new nodes above the threshold, sorted by retained size", () => {
    const { baseline, after } = leakyScenario();
    const diff = diffAgainstBaseline(summarizeBaseline(baseline, OPTIONS), after, OPTIONS);

    // The new closure has retained size 0, so the threshold filters it out.
    expect(diff.newNodes.map((finding) => finding.nodeType)).toEqual([
      "concatenated string",
      "concatenated string",
      "concatenated string",
    ]);
    const retained = diff.newNodes.map((finding) => finding.retainedBytes);
    expect(retained).toEqual([...retained].sort((a, b) => b - a));
  });

  it("computes per-type self-size deltas and drops small ones", () => {
    const { baseline, after } = leakyScenario();
    const diff = diffAgainstBaseline(summarizeBaseline(baseline, OPTIONS), after, OPTIONS);

    const concat = diff.typeDeltas.find((delta) => delta.type === "concatenated string");
    expect(concat?.deltaBytes).toBe(6 * KB);
    expect(diff.typeDeltas.find((delta) => delta.type === "object")).toBeUndefined();
  });

  it("does not track growth of nodes below the baseline retained floor (memory guard)", () => {
    const small = makeNode({ id: 20, name: "SmallCache", retainedSize: 10 * KB });
    const baseline = makeHeap([small]);
    const grownLater = makeNode({ id: 20, name: "SmallCache", retainedSize: 5000 * KB });
    const after = makeHeap([grownLater]);

    const diff = diffAgainstBaseline(summarizeBaseline(baseline, OPTIONS), after, OPTIONS);
    // Documented trade-off: it was too small to track in the baseline summary.
    expect(diff.grownNodes).toEqual([]);
    expect(diff.newNodes).toEqual([]);
  });
});

describe("module id harvesting", () => {
  it("collects ids from cache element edges of module instances on the chain", () => {
    const leaked = makeNode({ id: 1, name: "Leak", self_size: 4 * KB, retainedSize: 200 * KB });
    const namespace = makeNode({ id: 2, name: "Module", retainedSize: 300 * KB });
    const instance = makeNode({ id: 3, name: "Object" });
    instance.references = [{ name_or_index: "namespaceObject" }, { name_or_index: "exports" }];
    const cache = makeNode({ id: 4, name: "Object" });
    const backing = makeNode({ id: 5, type: "array", name: "(object elements)" });
    link(namespace, leaked, "leaked");
    link(instance, namespace, "namespaceObject");
    link(cache, instance, 35194, "element");
    link(backing, instance, 926, "internal");

    const diff = diffAgainstBaseline(
      summarizeBaseline(makeHeap([]), OPTIONS),
      makeHeap([leaked, namespace, instance, cache, backing]),
      OPTIONS
    );
    const found = diff.newNodes.find((entry) => entry.name === "Leak");
    // Only the element edge carries a real module id; the hash-slot internal
    // edge (926) must be ignored.
    expect(found?.moduleIds).toEqual([35194]);
  });
});

describe("retainerChain", () => {
  it("prefers strong edges from non-synthetic nodes", () => {
    const target = makeNode({ id: 1, name: "Leak" });
    const weakOwner = makeNode({ id: 2, name: "WeakMap" });
    const syntheticRoot = makeNode({ id: 3, type: "synthetic", name: "(GC roots)" });
    const realOwner = makeNode({ id: 4, name: "Registry" });
    link(weakOwner, target, "table", "weak");
    link(syntheticRoot, target, "root");
    link(realOwner, target, "entries");

    expect(retainerChain(target, 3)).toBe("Registry#object[.entries]");
  });

  it("stops on cycles instead of looping", () => {
    const a = makeNode({ id: 1, name: "A" });
    const b = makeNode({ id: 2, name: "B" });
    link(b, a, "up");
    link(a, b, "down");

    // The walk stops before revisiting A: no infinite loop, no repeated hop.
    expect(retainerChain(a, 10)).toBe("B#object[.up]");
  });
});

// Every suite above passes OPTIONS explicitly, so the shipped defaults — the
// only thresholds a real user ever runs with — were never exercised: mutating
// `20 * 1024` to `20 / 1024` survived. These pin each default at its exact
// boundary, one byte on either side.
describe("default thresholds", () => {
  it("keeps a new node at exactly the 2 KiB floor and drops the byte below it", () => {
    const atFloor = makeNode({ id: 1, name: "AtFloor", retainedSize: 2 * KB });
    const belowFloor = makeNode({ id: 2, name: "BelowFloor", retainedSize: 2 * KB - 1 });
    const diff = diffAgainstBaseline(summarizeBaseline(makeHeap([])), makeHeap([atFloor, belowFloor]));

    expect(diff.newNodes.map((finding) => finding.name)).toEqual(["AtFloor"]);
  });

  it("tracks a baseline node at exactly the 50 KiB retained floor, not the byte below", () => {
    const tracked = makeNode({ id: 1, name: "Tracked", retainedSize: 50 * KB });
    const untracked = makeNode({ id: 2, name: "Untracked", retainedSize: 50 * KB - 1 });
    const baseline = summarizeBaseline(makeHeap([tracked, untracked]));

    // Both grow hugely, but only the one summarized in the baseline can be compared.
    const diff = diffAgainstBaseline(baseline, makeHeap([
      makeNode({ id: 1, name: "Tracked", retainedSize: 50 * KB + 100 * KB }),
      makeNode({ id: 2, name: "Untracked", retainedSize: 5000 * KB }),
    ]));

    expect(diff.grownNodes.map((finding) => finding.name)).toEqual(["Tracked"]);
  });

  it("reports growth of exactly 100 KiB and ignores one byte less", () => {
    const baseline = summarizeBaseline(makeHeap([
      makeNode({ id: 1, name: "GrewEnough", retainedSize: 60 * KB }),
      makeNode({ id: 2, name: "GrewTooLittle", retainedSize: 60 * KB }),
    ]));
    const diff = diffAgainstBaseline(baseline, makeHeap([
      makeNode({ id: 1, name: "GrewEnough", retainedSize: 60 * KB + 100 * KB }),
      makeNode({ id: 2, name: "GrewTooLittle", retainedSize: 60 * KB + 100 * KB - 1 }),
    ]));

    expect(diff.grownNodes.map((finding) => finding.name)).toEqual(["GrewEnough"]);
  });

  it("keeps a type delta of exactly 20 KiB and drops the byte below it", () => {
    const baseline = summarizeBaseline(makeHeap([
      makeNode({ id: 1, type: "alpha", self_size: 0 }),
      makeNode({ id: 2, type: "beta", self_size: 0 }),
    ]));
    const diff = diffAgainstBaseline(baseline, makeHeap([
      makeNode({ id: 1, type: "alpha", self_size: 20 * KB }),
      makeNode({ id: 2, type: "beta", self_size: 20 * KB - 1 }),
    ]));

    expect(diff.typeDeltas.map((delta) => delta.type)).toEqual(["alpha"]);
  });
});

// A leak detector that calls shrinking memory a leak is worse than useless.
// Mutating `after - before` to `after + before` survived every existing test,
// because none of them ever measured something that got smaller.
describe("shrinking memory is not growth", () => {
  it("does not report a tracked node whose retained size fell", () => {
    const baseline = summarizeBaseline(makeHeap([
      makeNode({ id: 1, name: "Cache", retainedSize: 500 * KB }),
    ]));
    const diff = diffAgainstBaseline(baseline, makeHeap([
      makeNode({ id: 1, name: "Cache", retainedSize: 200 * KB }),
    ]));

    // A cache that drained is the opposite of a leak.
    expect(diff.grownNodes).toEqual([]);
  });

  it("reports a shrinking type as a negative delta", () => {
    const baseline = summarizeBaseline(makeHeap([
      makeNode({ id: 1, type: "gamma", self_size: 100 * KB }),
    ]));
    const diff = diffAgainstBaseline(baseline, makeHeap([
      makeNode({ id: 1, type: "gamma", self_size: 10 * KB }),
    ]));

    expect(diff.typeDeltas).toEqual([{ type: "gamma", deltaBytes: -90 * KB }]);
  });

  it("sums self sizes per type across nodes instead of cancelling them out", () => {
    const nodesOf = (size: number): HeapNodeLike[] => [
      makeNode({ id: 1, type: "delta", self_size: size }),
      makeNode({ id: 2, type: "delta", self_size: size }),
    ];
    const diff = diffAgainstBaseline(
      summarizeBaseline(makeHeap(nodesOf(50 * KB))),
      makeHeap(nodesOf(50 * KB))
    );

    // Same two nodes, same sizes: the type did not move at all.
    expect(diff.typeDeltas).toEqual([]);
  });
});

// The report leads with "the thing that grew most". If the ranking inverts,
// the tool accuses the wrong object — and the existing assertions compared
// the result against a re-sort of itself, which is true for any order.
describe("finding order", () => {
  it("ranks type deltas from most grown to most shrunk", () => {
    const baseline = summarizeBaseline(makeHeap([
      makeNode({ id: 1, type: "shrank", self_size: 120 * KB }),
      makeNode({ id: 2, type: "grew", self_size: 0 }),
    ]));
    const diff = diffAgainstBaseline(baseline, makeHeap([
      makeNode({ id: 1, type: "shrank", self_size: 20 * KB }),
      makeNode({ id: 2, type: "grew", self_size: 300 * KB }),
    ]));

    // Insertion order is shrank-then-grew, so only real sorting flips it.
    expect(diff.typeDeltas).toEqual([
      { type: "grew", deltaBytes: 300 * KB },
      { type: "shrank", deltaBytes: -100 * KB },
    ]);
  });

  it("ranks grown nodes by how much they grew, not by heap order", () => {
    const baseline = summarizeBaseline(makeHeap([
      makeNode({ id: 1, name: "Small", retainedSize: 100 * KB }),
      makeNode({ id: 2, name: "Big", retainedSize: 100 * KB }),
    ]));
    const diff = diffAgainstBaseline(baseline, makeHeap([
      makeNode({ id: 1, name: "Small", retainedSize: 250 * KB }),
      makeNode({ id: 2, name: "Big", retainedSize: 1000 * KB }),
    ]));

    expect(diff.grownNodes.map((finding) => finding.name)).toEqual(["Big", "Small"]);
  });

  it("ranks new nodes by retained size, not by heap order", () => {
    const diff = diffAgainstBaseline(summarizeBaseline(makeHeap([])), makeHeap([
      makeNode({ id: 1, name: "Small", retainedSize: 5 * KB }),
      makeNode({ id: 2, name: "Big", retainedSize: 500 * KB }),
    ]));

    expect(diff.newNodes.map((finding) => finding.name)).toEqual(["Big", "Small"]);
  });

  it("keeps only the top maxFindings of each list", () => {
    // Every size must clear the growth threshold, or the list is short enough
    // that dropping the slice changes nothing and the cap goes untested.
    const sizes = [150, 900, 200, 300, 700];
    const baseline = summarizeBaseline(
      makeHeap(sizes.map((_, index) => makeNode({ id: index + 1, retainedSize: 60 * KB })))
    );
    const grownHeap = makeHeap(
      sizes.map((size, index) => makeNode({ id: index + 1, retainedSize: 60 * KB + size * KB }))
    );
    const freshHeap = makeHeap(
      sizes.map((size, index) => makeNode({ id: index + 10, retainedSize: size * KB }))
    );

    expect(
      diffAgainstBaseline(baseline, freshHeap, { ...OPTIONS, maxFindings: 2 }).newNodes.map(
        (finding) => finding.retainedBytes
      )
    ).toEqual([900 * KB, 700 * KB]);
    expect(
      diffAgainstBaseline(baseline, grownHeap, { ...OPTIONS, maxFindings: 2 }).grownNodes.map(
        (finding) => finding.retainedBytes
      )
    ).toEqual([900 * KB, 700 * KB]);
  });

  it("labels findings as new or grown and joins their chain with arrows", () => {
    const owner = makeNode({ id: 9, name: "Registry" });
    const holder = makeNode({ id: 8, name: "Map" });
    const baseline = summarizeBaseline(
      makeHeap([makeNode({ id: 1, name: "Old", retainedSize: 200 * KB })])
    );
    const old = makeNode({ id: 1, name: "Old", retainedSize: 900 * KB });
    const born = makeNode({ id: 2, name: "New", retainedSize: 200 * KB });
    link(holder, old, "kept");
    link(holder, born, "kept");
    link(owner, holder, "store");
    const diff = diffAgainstBaseline(baseline, makeHeap([old, born]), OPTIONS);

    // Two hops, so the separator itself is under test.
    const chain = "Map#object[.kept] <- Registry#object[.store]";
    expect(diff.grownNodes[0]).toMatchObject({ kind: "grown", retainerChain: chain });
    expect(diff.newNodes[0]).toMatchObject({ kind: "new", retainerChain: chain });
  });
});

describe("retainer chain depth", () => {
  it("stops at exactly the requested depth on a longer chain", () => {
    const nodes = Array.from({ length: 6 }, (_, index) =>
      makeNode({ id: index + 1, name: `N${index}` })
    );
    for (let index = 0; index < nodes.length - 1; index += 1) {
      link(nodes[index + 1] as HeapNodeLike, nodes[index] as HeapNodeLike, "owns");
    }

    expect(retainerChain(nodes[0] as HeapNodeLike, 2).split(" <- ")).toHaveLength(2);
  });
});

// Module attribution is the difference between "something leaks" and "this
// file leaks". Its guards were only ever driven down the happy path.
describe("module id harvesting guards", () => {
  const moduleNode = (id: number, references: { name_or_index: string }[]): HeapNodeLike => {
    const node = makeNode({ id, name: "Object" });
    node.references = references;
    return node;
  };

  it("recognizes a module instance by exports alone", () => {
    const leaked = makeNode({ id: 1, name: "Leak", retainedSize: 200 * KB });
    const instance = moduleNode(2, [{ name_or_index: "exports" }]);
    const cache = makeNode({ id: 3, name: "Object" });
    link(instance, leaked, "held");
    link(cache, instance, 771, "element");

    const diff = diffAgainstBaseline(
      summarizeBaseline(makeHeap([])),
      makeHeap([leaked, instance, cache]),
      OPTIONS
    );
    expect(diff.newNodes.find((entry) => entry.name === "Leak")?.moduleIds).toEqual([771]);
  });

  it("recognizes a module instance whose other references are unrelated", () => {
    const leaked = makeNode({ id: 1, name: "Leak", retainedSize: 200 * KB });
    const instance = moduleNode(2, [{ name_or_index: "id" }, { name_or_index: "namespaceObject" }]);
    const cache = makeNode({ id: 3, name: "Object" });
    link(instance, leaked, "held");
    link(cache, instance, 812, "element");

    const diff = diffAgainstBaseline(
      summarizeBaseline(makeHeap([])),
      makeHeap([leaked, instance, cache]),
      OPTIONS
    );
    expect(diff.newNodes.find((entry) => entry.name === "Leak")?.moduleIds).toEqual([812]);
  });

  it("ignores element edges of nodes that are not module instances", () => {
    const leaked = makeNode({ id: 1, name: "Leak", retainedSize: 200 * KB });
    const plain = moduleNode(2, [{ name_or_index: "length" }]);
    const owner = makeNode({ id: 3, name: "Array" });
    link(plain, leaked, "held");
    link(owner, plain, 999, "element");

    const diff = diffAgainstBaseline(
      summarizeBaseline(makeHeap([])),
      makeHeap([leaked, plain, owner]),
      OPTIONS
    );
    expect(diff.newNodes.find((entry) => entry.name === "Leak")?.moduleIds).toEqual([]);
  });

  it("attributes a leaking node that is itself the module instance", () => {
    // The chain starts at the finding, so the finding itself must be searched
    // for module markers — a module-level `const cache = []` leaks exactly here.
    const leaked = moduleNode(1, [{ name_or_index: "namespaceObject" }]);
    leaked.name = "Leak";
    leaked.retainedSize = 200 * KB;
    const cache = makeNode({ id: 2, name: "Object" });
    link(cache, leaked, 555, "element");

    const diff = diffAgainstBaseline(
      summarizeBaseline(makeHeap([])),
      makeHeap([leaked, cache]),
      OPTIONS
    );
    expect(diff.newNodes.find((entry) => entry.name === "Leak")?.moduleIds).toEqual([555]);
  });

  it("deduplicates repeated ids and rejects non-numeric edge names", () => {
    const leaked = makeNode({ id: 1, name: "Leak", retainedSize: 200 * KB });
    const instance = moduleNode(2, [{ name_or_index: "namespaceObject" }]);
    const cacheA = makeNode({ id: 3, name: "Object" });
    const cacheB = makeNode({ id: 4, name: "Object" });
    const named = makeNode({ id: 5, name: "Object" });
    link(instance, leaked, "held");
    link(cacheA, instance, 42, "element");
    link(cacheB, instance, 42, "element");
    link(named, instance, "notAnId", "element");

    const diff = diffAgainstBaseline(
      summarizeBaseline(makeHeap([])),
      makeHeap([leaked, instance, cacheA, cacheB, named]),
      OPTIONS
    );
    expect(diff.newNodes.find((entry) => entry.name === "Leak")?.moduleIds).toEqual([42]);
  });
});

describe("label truncation", () => {
  it("flattens newlines to spaces and caps the length at 60 characters", () => {
    const name = `${"a".repeat(30)}\n${"b".repeat(40)}`;
    const diff = diffAgainstBaseline(
      summarizeBaseline(makeHeap([])),
      makeHeap([makeNode({ id: 1, name, retainedSize: 200 * KB })]),
      OPTIONS
    );

    const found = diff.newNodes[0];
    expect(found?.name).toBe(`${"a".repeat(30)} ${"b".repeat(29)}`);
  });
});

describe("diffSnapshotFiles", () => {
  it("parses baseline and after strictly in sequence with the injected loader", async () => {
    const { baseline, after } = leakyScenario();
    const loads: string[] = [];
    const diff = await diffSnapshotFiles(
      "/snap/base.heapsnapshot",
      "/snap/after.heapsnapshot",
      OPTIONS,
      async (file) => {
        loads.push(file);
        return file.includes("base") ? baseline : after;
      }
    );
    expect(loads).toEqual(["/snap/base.heapsnapshot", "/snap/after.heapsnapshot"]);
    expect(diff.grownNodes.length).toBeGreaterThan(0);
  });
});

describe("assertReadableSnapshot", () => {
  const write = async (name: string, content: string): Promise<string> => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "next-leak-snap-"));
    const file = path.join(dir, name);
    await writeFile(file, content);
    return file;
  };

  // memlab calls process.exit(1) on malformed input — no try/catch can save
  // the run, so bad files must be rejected before it ever sees them.
  it("rejects a truncated snapshot naming the likely cause", async () => {
    const file = await write("t.heapsnapshot", '{"snapshot":{"meta":{}},"nodes":[1,2,3');
    await expect(assertReadableSnapshot(file)).rejects.toMatchObject({
      name: "SnapshotError",
    });
    await assertReadableSnapshot(file).catch((error: unknown) => {
      expect(String((error as Error).message)).toContain("truncated");
    });
  });

  it("rejects empty, absent and non-snapshot files", async () => {
    await expect(assertReadableSnapshot(await write("e.heapsnapshot", ""))).rejects.toThrow("empty");
    await expect(
      assertReadableSnapshot(await write("x.heapsnapshot", '{"hello":"world"}'))
    ).rejects.toThrow("not a V8 heap snapshot");
    // The path deliberately avoids the word "missing": Node's own ENOENT text
    // quotes the filename, so a path named missing.heapsnapshot made this
    // assertion pass even with the guard removed.
    await expect(assertReadableSnapshot("/nope/absent.heapsnapshot")).rejects.toMatchObject({
      name: "SnapshotError",
    });
  });

  it("accepts a well-formed snapshot envelope", async () => {
    const file = await write("ok.heapsnapshot", '{"snapshot":{"meta":{"node_fields":["type"]}},"nodes":[],"strings":[]}');
    await expect(assertReadableSnapshot(file)).resolves.toBeUndefined();
  });

  // v8.writeHeapSnapshot output is not guaranteed to be whitespace-tight, and
  // rejecting a valid snapshot aborts the whole run — a false negative here is
  // as expensive as a missed leak.
  it("accepts an envelope padded with surrounding whitespace", async () => {
    const body = '{"snapshot":{"meta":{"node_fields":["type"]}},"nodes":[],"strings":[]}';
    await expect(
      assertReadableSnapshot(await write("pad.heapsnapshot", `\n  ${body}\n`))
    ).resolves.toBeUndefined();
  });
});
