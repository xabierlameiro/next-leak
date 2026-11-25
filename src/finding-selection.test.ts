import { describe, expect, it } from "vitest";
import { enclosingNote, SPECIFIC_SHARE, shownFindings } from "./finding-selection.js";
import type { NodeFinding } from "./heap-diff.js";

const MB = 1024 * 1024;

const finding = (
  name: string,
  retainedBytes: number,
  nodeId: number,
  containedIn?: number,
  kind: NodeFinding["kind"] = "grown"
): NodeFinding => ({
  kind,
  nodeType: "object",
  name,
  retainedBytes,
  retainerChain: "",
  moduleIds: [],
  nodeId,
  ...(containedIn !== undefined && { containedIn }),
});

// vercel/next.js#100492 on 16.4.6, 2026-11-23, run.json of the short run: each
// of the first three holds the next at 99.9% of its bytes, and the LRUCache at
// the bottom is the only one with an owner.
const ISSUE_100492 = {
  grownNodes: [
    finding("global", 95706560, 7069),
    finding("Object", 95686472, 232067, 7069),
    finding("system / Context", 95671064, 238759, 232067),
    finding("LRUCache", 95671064, 238805, 238759),
    finding("system / Context", 365272, 199619),
    finding("Map", 286008, 207883),
  ],
  newNodes: [],
};

describe("shownFindings", () => {
  it("leads with the store the wrappers hold", () => {
    const shown = shownFindings(ISSUE_100492);

    expect(shown.map((entry) => entry.finding.name)).toEqual([
      "LRUCache",
      "system / Context",
      "Map",
    ]);
    expect(shown[0]?.enclosing).toBe(3);
    // Attribution is aligned with the raw order, so the index is the LRUCache's.
    expect(shown[0]?.index).toBe(3);
    expect(shown[1]?.index).toBe(4);
  });

  it("keeps a container that retains plenty of its own", () => {
    // vercel/next.js#99335: fsChecker (3.32 MB) holds its LRU's table (0.92 MB).
    const shown = shownFindings({
      grownNodes: [finding("fsChecker", 3.32 * MB, 1)],
      newNodes: [finding("table", 0.92 * MB, 2, 1, "new")],
    });

    expect(shown.map((entry) => entry.finding.name)).toEqual(["fsChecker", "table"]);
    expect(shown.every((entry) => entry.enclosing === 0)).toBe(true);
  });

  it("folds a container at exactly the share, and not just under it", () => {
    const at = shownFindings({
      grownNodes: [finding("outer", 100, 1), finding("inner", 100 * SPECIFIC_SHARE, 2, 1)],
      newNodes: [],
    });
    const under = shownFindings({
      grownNodes: [finding("outer", 100, 1), finding("inner", 100 * SPECIFIC_SHARE - 1, 2, 1)],
      newNodes: [],
    });

    expect(at.map((entry) => entry.finding.name)).toEqual(["inner"]);
    expect(under.map((entry) => entry.finding.name)).toEqual(["outer", "inner"]);
  });

  it("prefers the larger of two held findings that both explain a container", () => {
    // In either order: the choice is by size, not by position.
    for (const held of [
      [finding("big", 95, 2, 1), finding("bigger", 99, 3, 1)],
      [finding("bigger", 99, 3, 1), finding("big", 95, 2, 1)],
    ]) {
      const shown = shownFindings({ grownNodes: [finding("outer", 100, 1), ...held], newNodes: [] });

      expect(shown[0]?.finding.name).toBe("bigger");
      expect(shown.map((entry) => entry.finding.name)).toContain("big");
    }
  });

  it("keeps the first of two held findings of the same size", () => {
    const shown = shownFindings({
      grownNodes: [finding("outer", 100, 1), finding("first", 95, 2, 1), finding("second", 95, 3, 1)],
      newNodes: [],
    });

    expect(shown.map((entry) => entry.finding.name)).toEqual(["first", "second"]);
  });

  it("leaves findings in size order when nothing records what holds it", () => {
    const shown = shownFindings({
      grownNodes: [finding("a", 3, 1), finding("b", 2, 2)],
      newNodes: [finding("c", 1, 3, undefined, "new")],
    });

    expect(shown.map((entry) => [entry.finding.name, entry.index, entry.enclosing])).toEqual([
      ["a", 0, 0],
      ["b", 1, 0],
      ["c", 2, 0],
    ]);
  });

  it("ignores a link to a finding that was not kept", () => {
    const shown = shownFindings({
      grownNodes: [finding("orphan", 5, 1, 999)],
      newNodes: [],
    });

    expect(shown.map((entry) => entry.finding.name)).toEqual(["orphan"]);
  });

  it("does not loop on a finding that claims to hold itself", () => {
    const shown = shownFindings({ grownNodes: [finding("self", 5, 1, 1)], newNodes: [] });

    expect(shown.map((entry) => [entry.finding.name, entry.enclosing])).toEqual([["self", 0]]);
  });

  it("does not loop on two findings that claim to hold each other", () => {
    const shown = shownFindings({
      grownNodes: [finding("a", 10, 1, 2), finding("b", 10, 2, 1)],
      newNodes: [],
    });

    // Dominator links cannot form a cycle; malformed input must still terminate
    // and name each finding once.
    expect(new Set(shown.map((entry) => entry.index)).size).toBe(shown.length);
    expect(shown.length).toBeLessThanOrEqual(2);
  });

  it("does not touch the diff it was given", () => {
    const grownNodes = [...ISSUE_100492.grownNodes];
    shownFindings({ grownNodes, newNodes: [] });

    expect(grownNodes.map((entry) => entry.name)).toEqual(
      ISSUE_100492.grownNodes.map((entry) => entry.name)
    );
  });
});

describe("enclosingNote", () => {
  it("says nothing when nothing was folded", () => {
    expect(enclosingNote(0)).toBe("");
  });

  it("counts what was folded", () => {
    expect(enclosingNote(1)).toBe(" · 1 finding around it holds the same bytes");
    expect(enclosingNote(3)).toBe(" · 3 findings around it hold the same bytes");
  });
});
