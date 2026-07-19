import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HeapDiff } from "./heap-diff.js";
import { loadSignatures, matchSignatures, readNextVersion } from "./signatures.js";

const testSignature = {
  id: "test-sig",
  title: "test signature",
  nextRange: ">=15.0.0 <16.1.0",
  cause: "because",
  issue: "https://github.com/vercel/next.js/issues/1",
  historical: true,
  match: { chainIncludes: "undici" },
};

function diffWithChain(chain: string): HeapDiff {
  return {
    typeDeltas: [{ type: "ArrayBuffer", deltaBytes: 5_000_000 }],
    grownNodes: [
      {
        kind: "grown",
        nodeType: "object",
        name: "Array",
        retainedBytes: 1,
        retainerChain: chain,
        moduleIds: [],
      },
    ],
    newNodes: [],
  };
}

describe("loadSignatures", () => {
  it("validates the built-in catalog at load time", () => {
    const signatures = loadSignatures();
    expect(signatures.length).toBeGreaterThan(0);
  });

  it("fails loudly on malformed entries", () => {
    expect(() => loadSignatures([{ id: "broken" }])).toThrow();
    expect(() =>
      loadSignatures([{ ...testSignature, nextRange: "not-a-range" }])
    ).toThrow();
    expect(() => loadSignatures([{ ...testSignature, match: {} }])).toThrow();
  });
});

describe("matchSignatures", () => {
  const signatures = loadSignatures([testSignature]);

  it("matches when the version satisfies the range and the chain hits", () => {
    const matched = matchSignatures(diffWithChain("x <- undici:Client <- y"), "16.0.1", signatures);
    expect(matched).toEqual([
      {
        id: "test-sig",
        title: "test signature",
        cause: "because",
        issue: "https://github.com/vercel/next.js/issues/1",
        historical: true,
      },
    ]);
  });

  it("never matches on unknown or out-of-range versions", () => {
    const diff = diffWithChain("x <- undici:Client <- y");
    expect(matchSignatures(diff, null, signatures)).toEqual([]);
    expect(matchSignatures(diff, "16.1.0", signatures)).toEqual([]);
    expect(matchSignatures(diff, "not-a-version", signatures)).toEqual([]);
  });

  it("supports type-delta rules", () => {
    const byDelta = loadSignatures([
      {
        ...testSignature,
        id: "delta-sig",
        match: { typeDeltaAbove: { type: "ArrayBuffer", bytes: 1_000_000 } },
      },
    ]);
    expect(matchSignatures(diffWithChain("no hit"), "16.0.0", byDelta)).toHaveLength(1);
  });
});

describe("readNextVersion", () => {
  it("reads the version from the standalone bundle", async () => {
    const appDir = await mkdtemp(path.join(tmpdir(), "next-leak-version-"));
    const pkgDir = path.join(appDir, ".next", "standalone", "node_modules", "next");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ version: "16.0.1" }));
    expect(await readNextVersion(appDir)).toBe("16.0.1");
  });

  it("returns null when no next package is present", async () => {
    const appDir = await mkdtemp(path.join(tmpdir(), "next-leak-version-"));
    expect(await readNextVersion(appDir)).toBeNull();
  });
});

// Signature annotations end up in public issue drafts: a silently loosened
// match rule would attach the wrong known cause to someone's report.
describe("signature matching precision", () => {
  const chainSig = loadSignatures([testSignature]);
  const deltaSig = loadSignatures([
    {
      ...testSignature,
      id: "delta-sig",
      match: { typeDeltaAbove: { type: "ArrayBuffer", bytes: 2_000_000 } },
    },
  ]);

  it("requires the chain substring to actually appear", () => {
    expect(matchSignatures(diffWithChain("undici"), "16.0.0", chainSig)).toHaveLength(1);
    expect(matchSignatures(diffWithChain("undic"), "16.0.0", chainSig)).toHaveLength(0);
    expect(matchSignatures(diffWithChain("UNDICI"), "16.0.0", chainSig)).toHaveLength(0);
  });

  it("matches type deltas at or above the threshold, and only for that type", () => {
    const withDelta = (type: string, deltaBytes: number) => ({
      typeDeltas: [{ type, deltaBytes }],
      grownNodes: [],
      newNodes: [],
    });
    expect(matchSignatures(withDelta("ArrayBuffer", 2_000_000), "16.0.0", deltaSig)).toHaveLength(1);
    expect(matchSignatures(withDelta("ArrayBuffer", 1_999_999), "16.0.0", deltaSig)).toHaveLength(0);
    expect(matchSignatures(withDelta("string", 9_000_000), "16.0.0", deltaSig)).toHaveLength(0);
  });

  it("checks new nodes' chains too, not only grown ones", () => {
    const diff = {
      typeDeltas: [],
      grownNodes: [],
      newNodes: [
        {
          kind: "new" as const,
          nodeType: "object",
          name: "n",
          retainedBytes: 1,
          retainerChain: "x <- undici:Client",
          moduleIds: [],
        },
      ],
    };
    expect(matchSignatures(diff, "16.0.0", chainSig)).toHaveLength(1);
  });

  it("gates strictly on the declared range boundaries", () => {
    const diff = diffWithChain("undici");
    // range is ">=15.0.0 <16.1.0"
    expect(matchSignatures(diff, "15.0.0", chainSig)).toHaveLength(1);
    expect(matchSignatures(diff, "14.9.9", chainSig)).toHaveLength(0);
    expect(matchSignatures(diff, "16.0.999", chainSig)).toHaveLength(1);
    expect(matchSignatures(diff, "16.1.0", chainSig)).toHaveLength(0);
  });

  it("carries every field the report prints", () => {
    const [matched] = matchSignatures(diffWithChain("undici"), "16.0.0", chainSig);
    expect(matched).toEqual({
      id: "test-sig",
      title: "test signature",
      cause: "because",
      issue: "https://github.com/vercel/next.js/issues/1",
      historical: true,
    });
  });

  it("ships a catalog whose entries are all well-formed and issue-linked", () => {
    for (const signature of loadSignatures()) {
      expect(signature.issue).toMatch(/^https:\/\/github\.com\/vercel\/next\.js\//);
      expect(signature.cause.length).toBeGreaterThan(20);
      expect(typeof signature.historical).toBe("boolean");
    }
  });

  it("rejects malformed entries field by field", () => {
    expect(() => loadSignatures([{ ...testSignature, issue: "not-a-url" }])).toThrow();
    expect(() => loadSignatures([{ ...testSignature, id: "" }])).toThrow();
    expect(() => loadSignatures([{ ...testSignature, historical: "yes" }])).toThrow();
    expect(() => loadSignatures([{ ...testSignature, extra: 1 }])).toThrow();
  });
});

describe("readNextVersion fallbacks", () => {
  it("falls back to the app's own node_modules when there is no standalone bundle", async () => {
    const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const pathModule = await import("node:path");
    const appDir = await mkdtemp(pathModule.join(tmpdir(), "next-leak-version-"));
    const pkgDir = pathModule.join(appDir, "node_modules", "next");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(pathModule.join(pkgDir, "package.json"), JSON.stringify({ version: "15.4.2" }));
    expect(await readNextVersion(appDir)).toBe("15.4.2");
  });

  it("returns null when the package.json has no version field", async () => {
    const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const pathModule = await import("node:path");
    const appDir = await mkdtemp(pathModule.join(tmpdir(), "next-leak-version-"));
    const pkgDir = pathModule.join(appDir, "node_modules", "next");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(pathModule.join(pkgDir, "package.json"), JSON.stringify({ name: "next" }));
    expect(await readNextVersion(appDir)).toBeNull();
  });
});

describe("shipped catalog contents", () => {
  it("marks each seeded signature with its real historical status", () => {
    const byId = new Map(loadSignatures().map((signature) => [signature.id, signature]));
    // #90433 was fixed upstream; #94919 was still open when seeded.
    expect(byId.get("standalone-fetch-undici-retention")?.historical).toBe(true);
    expect(byId.get("rsc-render-tree-per-request")?.historical).toBe(false);
  });

  it("keeps the ArrayBuffer threshold that avoids the false positive we measured", () => {
    const signature = loadSignatures().find((entry) => entry.id === "standalone-fetch-undici-retention");
    expect(signature?.match.typeDeltaAbove).toEqual({ type: "ArrayBuffer", bytes: 2 * 1024 * 1024 });
  });
});
