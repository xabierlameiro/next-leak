import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractChunkModules, extractModuleRegistry } from "./module-registry.js";

// Minimal base64-VLQ encoder, used only to build test sourcemaps. The decoder
// is validated independently against canonical vectors in vlq.test.ts.
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function encodeVlq(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = vlq & 0x1f;
    vlq >>>= 5;
    if (vlq > 0) {
      digit |= 0x20;
    }
    out += BASE64[digit];
  } while (vlq > 0);
  return out;
}

function segment(values: number[]): string {
  return values.map(encodeVlq).join("");
}

const CHUNK = 'module.exports=[10,()=>{leak()},20,b=>{helper(b)}]';
const SOURCES = ["[project]/app/one.ts", "[project]/node_modules/pkg/two.js"];

function makeMap() {
  const factory1 = CHUNK.indexOf("()=>{");
  const factory2 = CHUNK.indexOf("b=>{");
  // Two mapped tokens on line 0: factory 1 → source 0, factory 2 → source 1.
  const mappings = [
    segment([factory1, 0, 0, 0]),
    segment([factory2 - factory1, 1, 0, 0]),
  ].join(",");
  return { version: 3, sources: SOURCES, mappings };
}

describe("extractChunkModules", () => {
  it("pairs module ids with the source of the factory that follows them", () => {
    const modules = extractChunkModules(CHUNK, makeMap());
    expect(modules.get(10)).toBe("[project]/app/one.ts");
    expect(modules.get(20)).toBe("[project]/node_modules/pkg/two.js");
    expect(modules.size).toBe(2);
  });

  it("ignores non-Turbopack chunks", () => {
    expect(extractChunkModules("export default 42;", makeMap()).size).toBe(0);
  });

  it("supports sectioned sourcemaps with a banner line (Next 16.2/Sentry shape)", () => {
    // Banner on line 0, the module array on line 1 — as Sentry debug-id
    // injection produces. The section offset points at line 1.
    const banner = ";!function(){/* debug id */}();";
    const code = `${banner}\n${CHUNK}`;
    const factory1 = CHUNK.indexOf("()=>{");
    const factory2 = CHUNK.indexOf("b=>{");
    const sectioned = {
      version: 3,
      sources: [],
      sections: [
        {
          offset: { line: 1, column: 0 },
          map: {
            sources: SOURCES,
            mappings: [
              segment([factory1, 0, 0, 0]),
              segment([factory2 - factory1, 1, 0, 0]),
            ].join(","),
          },
        },
      ],
    };
    const modules = extractChunkModules(code, sectioned);
    expect(modules.get(10)).toBe("[project]/app/one.ts");
    expect(modules.get(20)).toBe("[project]/node_modules/pkg/two.js");
  });

  it("returns nothing for unrecognizable sourcemap shapes", () => {
    expect(extractChunkModules(CHUNK, { weird: true }).size).toBe(0);
  });

  // Regression: the original single-regex lookahead was quadratic — a 400 KB
  // gap dense with ids took ~11 s, so a large minified chunk could hang
  // registry extraction with no output at all.
  it("stays linear on large id-dense chunks (no catastrophic backtracking)", () => {
    const filler = ",1,".repeat(150_000); // ~450 KB of id-like noise
    const code = `module.exports=[10,()=>{${filler}},20,b=>{helper(b)}]`;
    const factory2 = code.indexOf("b=>{");
    const map = {
      version: 3,
      sources: SOURCES,
      mappings: [segment([code.indexOf("()=>{"), 0, 0, 0]), segment([factory2 - code.indexOf("()=>{"), 1, 0, 0])].join(","),
    };

    const started = performance.now();
    const modules = extractChunkModules(code, map);
    const elapsed = performance.now() - started;

    expect(modules.get(10)).toBe("[project]/app/one.ts");
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("extractModuleRegistry", () => {
  it("merges chunks with maps and skips files without them", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "next-leak-registry-"));
    await writeFile(path.join(dir, "chunk.js"), CHUNK);
    await writeFile(path.join(dir, "chunk.js.map"), JSON.stringify(makeMap()));
    await writeFile(path.join(dir, "orphan.js"), "module.exports=[30,()=>{}]");
    await writeFile(path.join(dir, "broken.js"), CHUNK);
    await writeFile(path.join(dir, "broken.js.map"), "not json");

    const registry = await extractModuleRegistry(dir);
    expect(registry.get(10)).toBe("[project]/app/one.ts");
    expect(registry.size).toBe(2);
  });

  it("returns an empty registry for a missing directory", async () => {
    expect((await extractModuleRegistry("/nope/nothing")).size).toBe(0);
  });
});

describe("sectioned sourcemap arithmetic", () => {
  it("applies the column shift only to the section's first line", () => {
    const line0 = "module.exports=[10,()=>{leakA()}";
    const line1 = ",20,b=>{helperB(b)}]";
    const code = `banner\n${line0}\n${line1}`;
    const sectioned = {
      version: 3,
      sections: [
        {
          // Section starts at line 1, column 7 — only that line is shifted;
          // the next line starts at column 0 again.
          offset: { line: 1, column: 7 },
          map: {
            sources: ["[project]/a.ts", "[project]/b.ts"],
            mappings:
              segment([line0.indexOf("()=>{") - 7, 0, 0, 0]) +
              ";" +
              segment([line1.indexOf("b=>{"), 1, 0, 0]),
          },
        },
      ],
    };
    const modules = extractChunkModules(code, sectioned);
    expect(modules.get(10)).toBe("[project]/a.ts");
    expect(modules.get(20)).toBe("[project]/b.ts");
  });

  it("offsets source indices per section so later sections do not alias earlier ones", () => {
    const code = `module.exports=[10,()=>{a()},20,()=>{b()}]`;
    const first = code.indexOf("()=>{a");
    const second = code.indexOf("()=>{b");
    const sectioned = {
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: { sources: ["[project]/first.ts"], mappings: segment([first, 0, 0, 0]) },
        },
        {
          offset: { line: 0, column: 0 },
          map: { sources: ["[project]/second.ts"], mappings: segment([second, 0, 0, 0]) },
        },
      ],
    };
    const modules = extractChunkModules(code, sectioned);
    expect(modules.get(10)).toBe("[project]/first.ts");
    expect(modules.get(20)).toBe("[project]/second.ts");
  });

  it("accepts the spaced `module.exports = [` form", () => {
    const code = "module.exports = [77,()=>{x()}]";
    const map = { version: 3, sources: ["[project]/spaced.ts"], mappings: segment([code.indexOf("()=>{"), 0, 0, 0]) };
    expect(extractChunkModules(code, map).get(77)).toBe("[project]/spaced.ts");
  });

  it("keeps the first source when the same id appears twice", () => {
    const code = "module.exports=[5,()=>{a()},5,()=>{b()}]";
    const first = code.indexOf("()=>{a");
    const second = code.indexOf("()=>{b");
    const map = {
      version: 3,
      sources: ["[project]/first.ts", "[project]/second.ts"],
      mappings: [segment([first, 0, 0, 0]), segment([second - first, 1, 0, 0])].join(","),
    };
    expect(extractChunkModules(code, map).get(5)).toBe("[project]/first.ts");
  });
});

describe("registry file scanning", () => {
  it("ignores non-.js files even when they have maps alongside", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "next-leak-registry-"));
    await writeFile(path.join(dir, "chunk.mjs"), CHUNK);
    await writeFile(path.join(dir, "chunk.mjs.map"), JSON.stringify(makeMap()));
    await writeFile(path.join(dir, "notes.txt"), CHUNK);
    expect((await extractModuleRegistry(dir)).size).toBe(0);
  });
});

// The remaining survivors lived in span/boundary arithmetic: a loosened
// comparison here silently attributes a leak to the wrong source file.
describe("factory span boundaries", () => {
  const code = "module.exports=[10,()=>{a()},20,()=>{b()}]";
  const firstFactory = code.indexOf("()=>{a");
  const secondFactory = code.indexOf("()=>{b");
  const secondId = code.indexOf(",20,");

  const mapWithEntryAt = (column: number, sourceIndex: number) => ({
    version: 3,
    sources: ["[project]/first.ts", "[project]/second.ts"],
    mappings: segment([column, sourceIndex, 0, 0]),
  });

  it("ignores a mapped token that lands before the first id", () => {
    // Column 5 is inside "module.exports=[", ahead of any id.
    expect(extractChunkModules(code, mapWithEntryAt(5, 0)).size).toBe(0);
  });

  it("ignores a mapped token that falls past the next id (outside the span)", () => {
    // A token after ",20," belongs to the second factory, not the first.
    expect(extractChunkModules(code, mapWithEntryAt(secondFactory, 0)).get(10)).toBeUndefined();
  });

  it("accepts a token exactly at the start of the span", () => {
    const idEnd = code.indexOf("(") ;
    expect(extractChunkModules(code, mapWithEntryAt(idEnd, 0)).get(10)).toBe("[project]/first.ts");
  });

  it("pairs the id immediately preceding a factory, not an earlier one", () => {
    const map = {
      version: 3,
      sources: ["[project]/first.ts", "[project]/second.ts"],
      mappings: [segment([firstFactory, 0, 0, 0]), segment([secondFactory - firstFactory, 1, 0, 0])].join(","),
    };
    const modules = extractChunkModules(code, map);
    expect(modules.get(10)).toBe("[project]/first.ts");
    expect(modules.get(20)).toBe("[project]/second.ts");
    expect(modules.size).toBe(2);
  });

  it("drops entries whose source index is out of range", () => {
    const map = { version: 3, sources: [], mappings: segment([firstFactory, 0, 0, 0]) };
    expect(extractChunkModules(code, map).size).toBe(0);
  });

  it("ignores mappings for lines the chunk does not have", () => {
    const map = {
      version: 3,
      sources: ["[project]/first.ts"],
      mappings: [";", ";", segment([0, 0, 0, 0])].join(""),
    };
    expect(extractChunkModules(code, map).size).toBe(0);
  });

  it("requires the module.exports array marker", () => {
    expect(extractChunkModules(`const x=[10,()=>{a()}]`, mapWithEntryAt(firstFactory, 0)).size).toBe(0);
    expect(secondId).toBeGreaterThan(0);
  });

  it("sorts merged section entries by column so spans are evaluated in order", () => {
    // Two sections contributing to the same line out of order.
    const sectioned = {
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: { sources: ["[project]/second.ts"], mappings: segment([secondFactory, 0, 0, 0]) },
        },
        {
          offset: { line: 0, column: 0 },
          map: { sources: ["[project]/first.ts"], mappings: segment([firstFactory, 0, 0, 0]) },
        },
      ],
    };
    const modules = extractChunkModules(code, sectioned);
    expect(modules.get(10)).toBe("[project]/first.ts");
    expect(modules.get(20)).toBe("[project]/second.ts");
  });
});

describe("section entry ordering", () => {
  it("evaluates spans in column order even when sections arrive reversed", () => {
    // Three ids; sections deliberately supplied last-first so an unsorted
    // merge would pair the wrong id with the wrong source.
    const code = "module.exports=[10,()=>{a()},20,()=>{b()},30,()=>{c()}]";
    const columns = [code.indexOf("()=>{a"), code.indexOf("()=>{b"), code.indexOf("()=>{c")];
    const sectioned = {
      version: 3,
      sections: [2, 1, 0].map((index) => ({
        offset: { line: 0, column: 0 },
        map: {
          sources: [`[project]/s${index}.ts`],
          mappings: segment([columns[index] ?? 0, 0, 0, 0]),
        },
      })),
    };
    const modules = extractChunkModules(code, sectioned);
    expect(modules.get(10)).toBe("[project]/s0.ts");
    expect(modules.get(20)).toBe("[project]/s1.ts");
    expect(modules.get(30)).toBe("[project]/s2.ts");
  });
});
