import { describe, expect, it } from "vitest";
import { attributeDiff, attributeFinding, classifySource } from "./attribution.js";
import type { HeapDiff, NodeFinding } from "./heap-diff.js";

describe("classifySource", () => {
  it("classifies project sources as app code with a relative path", () => {
    expect(classifySource("turbopack:///[project]/src/app/leaky/page.tsx")).toEqual({
      owner: "app",
      source: "src/app/leaky/page.tsx",
      packageName: null,
    });
  });

  it("classifies node_modules as dependency, naming scoped packages", () => {
    expect(
      classifySource("turbopack:///[project]/node_modules/@scope/pkg/dist/index.js")
    ).toMatchObject({ owner: "dependency", packageName: "@scope/pkg" });
    expect(
      classifySource("[project]/node_modules/.pnpm/x@1/node_modules/lodash/index.js")
    ).toMatchObject({ owner: "dependency", packageName: "lodash" });
  });

  it("classifies URL-encoded relative paths (Next 16.2 sectioned-map dialect)", () => {
    expect(
      classifySource("../../../../app/components/detail/candidate-comment-item/index.tsx")
    ).toEqual({
      owner: "app",
      source: "app/components/detail/candidate-comment-item/index.tsx",
      packageName: null,
    });
    expect(
      classifySource(
        "../../../node_modules/.pnpm/%40aws-sdk%2Bnested-clients%403.997.33/node_modules/%40aws-sdk/nested-clients/dist/index.js"
      )
    ).toMatchObject({ owner: "dependency", packageName: "@aws-sdk/nested-clients" });
    expect(
      classifySource(
        "../../../node_modules/.pnpm/next%4016.2.10_x/node_modules/next/dist/server/x.js"
      ).owner
    ).toBe("framework");
  });

  it("classifies next, react, and bundler runtime as framework", () => {
    expect(
      classifySource("[project]/node_modules/next/dist/esm/server/index.js").owner
    ).toBe("framework");
    expect(classifySource("[turbopack]/runtime.js").owner).toBe("framework");
    expect(classifySource("[root-of-the-server]/x.js").owner).toBe("framework");
  });
});

function finding(partial: Partial<NodeFinding>): NodeFinding {
  return {
    kind: "grown",
    nodeType: "object",
    name: "Array",
    retainedBytes: 0,
    retainerChain: "",
    moduleIds: [],
    ...partial,
  };
}

const registry = new Map([
  [35194, "turbopack:///[project]/src/app/leaky/page.tsx"],
  [70000, "[project]/node_modules/heavy-lib/index.js"],
]);

describe("attributeFinding", () => {
  it("resolves the first registry-known module id", () => {
    const result = attributeFinding(finding({ moduleIds: [926, 35194] }), registry);
    expect(result).toEqual({ owner: "app", source: "src/app/leaky/page.tsx", packageName: null });
  });

  it("prefers app ownership over framework wrappers on the same chain", () => {
    const withWrapper = new Map([
      ...registry,
      [59067, "[project]/node_modules/next/dist/esm/build/templates/app-page.js?page=/leaky/page"],
    ]);
    // Wrapper appears first (closer to the leak on this chain) — app still wins.
    const result = attributeFinding(finding({ moduleIds: [59067, 35194] }), withWrapper);
    expect(result.owner).toBe("app");
    expect(result.source).toBe("src/app/leaky/page.tsx");
    // Wrapper alone resolves as framework rather than unattributed.
    expect(attributeFinding(finding({ moduleIds: [59067] }), withWrapper).owner).toBe("framework");
  });

  it("degrades to unattributed when nothing resolves", () => {
    expect(attributeFinding(finding({ moduleIds: [1, 2] }), registry).owner).toBe("unattributed");
    expect(attributeFinding(finding({ moduleIds: [] }), registry).owner).toBe("unattributed");
  });
});

describe("attributeDiff", () => {
  it("aligns findings and elects the dominant owner by retained bytes", () => {
    const diff: HeapDiff = {
      typeDeltas: [],
      grownNodes: [
        finding({ moduleIds: [35194], retainedBytes: 5_000_000 }),
        finding({ moduleIds: [70000], retainedBytes: 1_000_000 }),
      ],
      newNodes: [finding({ moduleIds: [], retainedBytes: 3_000_000 })],
    };
    const result = attributeDiff(diff, registry);
    expect(result.findings.map((entry) => entry.owner)).toEqual([
      "app",
      "dependency",
      "unattributed",
    ]);
    expect(result.route.owner).toBe("app");
    expect(result.route.source).toBe("src/app/leaky/page.tsx");
    // Unattributed bytes count toward the share: they are growth too.
    expect(result.route.dominance).toBeCloseTo(5 / 9);
  });

  it("names no culprit when what nobody owns outweighs every owner", () => {
    // An `app` culprit tells the issue draft not to file upstream, so it must
    // not be elected over a larger store the run could not name.
    const diff: HeapDiff = {
      typeDeltas: [],
      grownNodes: [finding({ moduleIds: [35194], retainedBytes: 5_000_000 })],
      newNodes: [finding({ moduleIds: [], retainedBytes: 9_000_000 })],
    };
    expect(attributeDiff(diff, registry).route).toEqual({
      owner: "unattributed",
      source: null,
      packageName: null,
      dominance: 0,
    });
  });

  it("keeps the owner when what nobody owns only ties it", () => {
    const diff: HeapDiff = {
      typeDeltas: [],
      grownNodes: [finding({ moduleIds: [35194], retainedBytes: 4_000_000 })],
      newNodes: [finding({ moduleIds: [], retainedBytes: 4_000_000 })],
    };
    const route = attributeDiff(diff, registry).route;

    expect(route.owner).toBe("app");
    expect(route.dominance).toBeCloseTo(0.5);
  });

  it("stays unattributed when no finding resolves", () => {
    const diff: HeapDiff = {
      typeDeltas: [],
      grownNodes: [finding({ retainedBytes: 1000 })],
      newNodes: [],
    };
    expect(attributeDiff(diff, registry).route).toEqual({
      owner: "unattributed",
      source: null,
      packageName: null,
      dominance: 0,
    });
  });
});

// Targeted at mutants that survived the first mutation run: each of these
// encodes a behavior a user would notice if it silently flipped.
describe("attribution precedence and edge shapes", () => {
  const registry = new Map([
    [1, "[project]/src/app/page.tsx"],
    [2, "[project]/node_modules/heavy/index.js"],
    [3, "[project]/node_modules/next/dist/server/x.js"],
    [4, "[turbopack]/runtime.js"],
  ]);

  it("prefers dependency over framework when both are on the chain", () => {
    expect(attributeFinding({ moduleIds: [3, 2], retainerChain: "" }, registry)).toMatchObject({
      owner: "dependency",
      packageName: "heavy",
    });
  });

  it("keeps the first match when two modules share the same owner class", () => {
    const twoApps = new Map([
      [1, "[project]/src/app/first.tsx"],
      [2, "[project]/src/app/second.tsx"],
    ]);
    expect(attributeFinding({ moduleIds: [1, 2], retainerChain: "" }, twoApps).source).toBe(
      "src/app/first.tsx"
    );
  });

  it("only strips the turbopack scheme at the start of the path", () => {
    // A path merely containing the scheme mid-string must not be rewritten.
    expect(classifySource("[project]/src/a/turbopack:///[x].ts")).toMatchObject({
      owner: "app",
      source: "src/a/turbopack:///[x].ts",
    });
  });

  it("does not treat bundler-internal relative paths as app code", () => {
    expect(classifySource("../../[turbopack]/runtime.js").owner).toBe("framework");
  });

  it("keeps the largest owner group when bytes tie on the first-seen entry", () => {
    const finding = (moduleIds: number[], retainedBytes: number) => ({
      kind: "grown" as const,
      nodeType: "object",
      name: "n",
      retainedBytes,
      retainerChain: "",
      moduleIds,
    });
    const diff = {
      typeDeltas: [],
      grownNodes: [finding([2], 1000), finding([1], 1000)],
      newNodes: [],
    };
    // Equal bytes: the first group encountered wins, deterministically.
    const result = attributeDiff(diff, registry);
    expect(result.route.owner).toBe("dependency");
    expect(result.route.dominance).toBeCloseTo(0.5);
  });
});

// Motivated by confirming vercel/next.js#94890: the chain plainly ran through
// Next's route filesystem checker, yet no module id resolved and the finding
// came out `unattributed`.
describe("chain-based framework detection", () => {
  const chain = (retainerChain: string) =>
    attributeFinding({ moduleIds: [], retainerChain }, new Map());

  it("recognises Next internals by name when no module id resolves", () => {
    expect(chain("system / Context#object[.fsChecker] <- logError#closure[.context]")).toEqual({
      owner: "framework",
      source: null,
      packageName: "next (route filesystem checker)",
    });
    expect(chain("getDynamicRoutes#closure[.context] <- x").packageName).toBe(
      "next (dynamic route matcher)"
    );
    expect(chain("NextNodeServer#object[.x]").packageName).toBe("next (Next server)");
  });

  // Chains copied from the vercel/next.js#99335 reproduction, 12 cycles ×
  // 20,000 requests on next@16.4.0-canary.50.
  const SHARED_CACHE_CONTROLS_CHAIN =
    "Map#object[.table] <- system / PropertyArray#hidden[.2] <- " +
    "SharedCacheControls#closure[.properties] <- system / Context#object[.1] <- " +
    "clear#closure[.context] <- system / PropertyArray#hidden[.3] <- Object#object[.properties]";
  const FS_CHECKER_CHAIN =
    "system / Context#object[.fsChecker] <- match#closure[.context] <- " +
    "Object#object[.match] <- (object elements)#array[.5] <- Array#object[.elements]";

  it("names the shared cache controls store", () => {
    expect(chain(SHARED_CACHE_CONTROLS_CHAIN).packageName).toBe("next (shared cache controls)");
  });

  it("names the shared cache controls before the incremental cache that holds them", () => {
    expect(
      chain("SharedCacheControls#closure[.properties] <- IncrementalCache#object[.x]").packageName
    ).toBe("next (shared cache controls)");
  });

  // Nesting as measured on the 4 × 5000 run of the same reproduction: Next's
  // server context dominates the fsChecker object, which dominates its LRU's
  // table. Raw sums counted that one store three times.
  function nestedDiff(): HeapDiff {
    const node = (
      kind: "grown" | "new",
      nodeId: number,
      retainedBytes: number,
      retainerChain: string,
      containedIn?: number
    ) => ({
      kind,
      nodeType: "object",
      name: "",
      retainedBytes,
      retainerChain,
      moduleIds: [],
      nodeId,
      ...(containedIn !== undefined && { containedIn }),
    });
    return {
      typeDeltas: [],
      grownNodes: [
        node("grown", 1, 3_324_480, "logError#closure[.context] <- process#object[.properties]"),
        node("grown", 2, 3_319_560, FS_CHECKER_CHAIN, 1),
      ],
      newNodes: [
        node("new", 3, 2_058_112, SHARED_CACHE_CONTROLS_CHAIN),
        node("new", 4, 917_544, "Map#object[.table] <- LRUCache#object[.cache] <- length#closure", 2),
      ],
    };
  }

  it("counts a store once, not once per level that contains it", () => {
    const route = attributeDiff(nestedDiff(), new Map()).route;
    // The fsChecker object and the LRU it dominates hold 3,319,560 bytes
    // between them; the server context keeps only the 4,920 outside both.
    const total = 4_920 + 3_319_560 + 2_058_112;

    expect(route.packageName).toBe("next (route filesystem checker)");
    expect(route.dominance).toBeCloseTo(3_319_560 / total);
  });

  it("gives an unnamed finding the owner of the finding that dominates it", () => {
    const result = attributeDiff(nestedDiff(), new Map());

    expect(result.findings[3]?.packageName).toBe("next (route filesystem checker)");
    // The outer context has no owner to pass down to the fsChecker object.
    expect(result.findings[0]?.owner).toBe("unattributed");
  });

  it("inherits through an unnamed intermediate finding", () => {
    const diff = nestedDiff();
    const [outer, middle] = diff.grownNodes;
    if (outer === undefined || middle === undefined) throw new Error("fixture broken");
    diff.grownNodes = [
      { ...outer, retainerChain: FS_CHECKER_CHAIN },
      { ...middle, retainerChain: "Object#object[.x]" },
    ];

    expect(attributeDiff(diff, new Map()).findings[3]?.packageName).toBe(
      "next (route filesystem checker)"
    );
  });

  it("ignores a link to a finding that is not in the diff", () => {
    const diff = nestedDiff();
    const lru = diff.newNodes[1];
    if (lru === undefined) throw new Error("fixture broken");
    diff.newNodes[1] = { ...lru, containedIn: 999 };

    expect(attributeDiff(diff, new Map()).findings[3]?.owner).toBe("unattributed");
  });

  it("never lets a container's share go negative", () => {
    const diff = nestedDiff();
    const outer = diff.grownNodes[0];
    if (outer === undefined) throw new Error("fixture broken");
    // A container whose delta is smaller than what it contains: the child
    // grew while something else under the container shrank.
    diff.grownNodes[0] = { ...outer, retainedBytes: 1_000 };
    const route = attributeDiff(diff, new Map()).route;

    expect(route.dominance).toBeCloseTo(3_319_560 / (3_319_560 + 2_058_112));
  });

  it("keeps a named finding's own owner inside a container named otherwise", () => {
    const diff = nestedDiff();
    const lru = diff.newNodes[1];
    if (lru === undefined) throw new Error("fixture broken");
    diff.newNodes[1] = { ...lru, retainerChain: SHARED_CACHE_CONTROLS_CHAIN };

    expect(attributeDiff(diff, new Map()).findings[3]?.packageName).toBe(
      "next (shared cache controls)"
    );
  });

  it("stops inheriting when malformed links form a cycle", () => {
    const diff = nestedDiff();
    const [outer, middle] = diff.grownNodes;
    if (outer === undefined || middle === undefined) throw new Error("fixture broken");
    diff.grownNodes = [
      { ...outer, containedIn: 4 },
      { ...middle, retainerChain: "Object#object[.x]" },
    ];
    const result = attributeDiff(diff, new Map());

    expect(result.findings[0]?.owner).toBe("unattributed");
    expect(result.findings[3]?.owner).toBe("unattributed");
  });

  it("names no culprit when no finding holds a byte of its own", () => {
    const diff: HeapDiff = {
      typeDeltas: [],
      grownNodes: [finding({ retainedBytes: 0, retainerChain: FS_CHECKER_CHAIN })],
      newNodes: [],
    };

    expect(attributeDiff(diff, new Map()).route).toEqual({
      owner: "unattributed",
      source: null,
      packageName: null,
      dominance: 0,
    });
  });

  it("hands the route to the store that grew most once it has a name", () => {
    // Before, the 19.84 MB map was unattributed and the bounded 9.31 MB
    // fsChecker LRU won the route with a dominance of 1.
    const node = (kind: "grown" | "new", retainedBytes: number, retainerChain: string) => ({
      kind,
      nodeType: kind === "new" ? "array" : "object",
      name: "",
      retainedBytes,
      retainerChain,
      moduleIds: [],
    });
    const diff: HeapDiff = {
      typeDeltas: [],
      grownNodes: [node("grown", 9_760_000, FS_CHECKER_CHAIN)],
      newNodes: [node("new", 20_800_000, SHARED_CACHE_CONTROLS_CHAIN)],
    };
    const result = attributeDiff(diff, new Map());

    expect(result.route.packageName).toBe("next (shared cache controls)");
    expect(result.route.dominance).toBeCloseTo(20_800_000 / 30_560_000);
  });

  it("stays unattributed for chains with no known marker", () => {
    expect(chain("Object#object[.foo] <- Array#object[.bar]").owner).toBe("unattributed");
    expect(chain("").owner).toBe("unattributed");
  });

  it("never overrides a resolved source path with a chain guess", () => {
    const registry = new Map([[7, "[project]/src/app/page.tsx"]]);
    const result = attributeFinding(
      { moduleIds: [7], retainerChain: "system / Context#object[.fsChecker]" },
      registry
    );
    expect(result).toMatchObject({ owner: "app", source: "src/app/page.tsx" });
  });
});
