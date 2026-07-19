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
      newNodes: [finding({ moduleIds: [], retainedBytes: 9_000_000 })],
    };
    const result = attributeDiff(diff, registry);
    expect(result.findings.map((entry) => entry.owner)).toEqual([
      "app",
      "dependency",
      "unattributed",
    ]);
    expect(result.route.owner).toBe("app");
    expect(result.route.source).toBe("src/app/leaky/page.tsx");
    expect(result.route.dominance).toBeCloseTo(5 / 6);
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
