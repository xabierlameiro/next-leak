import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { decodeMappings, type LineMapping } from "./vlq.js";

/** Bundler module id → source path (e.g. `[project]/src/app/leaky/page.tsx`). */
export type ModuleRegistry = ReadonlyMap<number, string>;

const flatMapSchema = z.looseObject({
  version: z.number(),
  sources: z.array(z.string()),
  mappings: z.string(),
});

// Sectioned maps (spec §index maps) — emitted e.g. by Next 16.2/Sentry builds.
const sectionedMapSchema = z.looseObject({
  version: z.number(),
  sections: z.array(
    z.looseObject({
      offset: z.looseObject({ line: z.number(), column: z.number() }),
      map: z.looseObject({ sources: z.array(z.string()), mappings: z.string() }),
    })
  ),
});

type NormalizedSourceMap = { sources: string[]; lines: LineMapping[] };

/** Accepts flat or sectioned sourcemaps; null when it is neither. */
function normalizeSourceMap(raw: unknown): NormalizedSourceMap | null {
  const flat = flatMapSchema.safeParse(raw);
  if (flat.success) {
    return { sources: flat.data.sources, lines: decodeMappings(flat.data.mappings) };
  }
  const sectioned = sectionedMapSchema.safeParse(raw);
  if (!sectioned.success) {
    return null;
  }

  const sources: string[] = [];
  const lines: LineMapping[] = [];
  for (const section of sectioned.data.sections) {
    const sourceBase = sources.length;
    sources.push(...section.map.sources);
    for (const [lineIndex, mapping] of decodeMappings(section.map.mappings).entries()) {
      const targetLine = section.offset.line + lineIndex;
      const columnShift = lineIndex === 0 ? section.offset.column : 0;
      const target = (lines[targetLine] ??= { entries: [] });
      for (const entry of mapping.entries) {
        target.entries.push({
          column: entry.column + columnShift,
          sourceIndex: entry.sourceIndex + sourceBase,
        });
      }
    }
  }
  for (const line of lines) {
    line?.entries.sort((a, b) => a.column - b.column);
  }
  // Sparse arrays confuse iteration downstream; fill the holes.
  for (let i = 0; i < lines.length; i += 1) {
    lines[i] ??= { entries: [] };
  }
  return { sources, lines };
}

const ID_IN_GAP = /[,[](\d{1,9}),/g;

/**
 * Last `,<id>,` (or `[<id>,`) in the generated-only gap before a factory.
 *
 * A single regex with a negative lookahead (`(?![\s\S]*...)`) expressed this
 * in one line but was quadratic: on a 400 KB gap dense with ids it took ~11 s,
 * so a large minified chunk could hang registry extraction with no output.
 * Scanning forward and keeping the last match is linear.
 */
function lastModuleIdIn(gap: string): number | null {
  ID_IN_GAP.lastIndex = 0;
  let last: number | null = null;
  let match = ID_IN_GAP.exec(gap);
  while (match !== null) {
    last = Number(match[1]);
    match = ID_IN_GAP.exec(gap);
  }
  return last;
}

/**
 * Extracts `[id, factory, ...]` pairs from a Turbopack CJS chunk by walking
 * the sourcemap instead of lexing JavaScript: each factory is a contiguous
 * region mapped to one source, so a change of source index marks a factory
 * boundary, and the module id is the last integer literal in the unmapped
 * gap right before it. Non-Turbopack chunks contribute nothing.
 */
export function extractChunkModules(code: string, rawMap: unknown): Map<number, string> {
  const result = new Map<number, string>();
  if (!code.includes("module.exports=[") && !code.includes("module.exports = [")) {
    return result;
  }
  const map = normalizeSourceMap(rawMap);
  if (map === null) {
    return result;
  }

  const codeLines = code.split("\n");

  // Boundary case the transition walk misses: the array's FIRST id, when a
  // mapping entry lands before the id's trailing comma. Pair it with the
  // first mapped token inside its own factory span (before the next id).
  for (const [lineIndex, lineText] of codeLines.entries()) {
    const first = /module\.exports ?= ?\[(\d+),/.exec(lineText);
    if (first?.[1] === undefined) {
      continue;
    }
    const idEnd = first.index + first[0].length;
    const nextId = /[,[]\d{1,9},/.exec(lineText.slice(idEnd));
    const spanEnd = nextId === null ? lineText.length : idEnd + nextId.index;
    const entry = map.lines[lineIndex]?.entries.find(
      (candidate) => candidate.column >= idEnd && candidate.column < spanEnd
    );
    const source = entry === undefined ? undefined : map.sources[entry.sourceIndex];
    if (source !== undefined) {
      result.set(Number(first[1]), source);
    }
  }

  for (const [lineIndex, mapping] of map.lines.entries()) {
    const lineText = codeLines[lineIndex];
    if (lineText === undefined) {
      continue;
    }
    let previousColumn = 0;
    let previousSource: number | null = null;
    for (const entry of mapping.entries) {
      if (entry.sourceIndex !== previousSource) {
        const id = lastModuleIdIn(lineText.slice(previousColumn, entry.column));
        const source = map.sources[entry.sourceIndex];
        if (id !== null && source !== undefined && !result.has(id)) {
          result.set(id, source);
        }
        previousSource = entry.sourceIndex;
      }
      previousColumn = entry.column;
    }
  }
  return result;
}

async function jsFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(path.join(entry.parentPath, entry.name));
    }
  }
  return out;
}

/**
 * Builds the module registry by scanning every server chunk that has an
 * adjacent sourcemap. Missing maps, unparseable chunks, or non-Turbopack
 * builds simply contribute nothing: an empty registry means every finding
 * degrades to `unattributed`.
 */
export async function extractModuleRegistry(nextServerDir: string): Promise<ModuleRegistry> {
  const registry = new Map<number, string>();
  for (const file of await jsFilesUnder(nextServerDir)) {
    let code: string;
    let map: unknown;
    try {
      code = await readFile(file, "utf8");
      map = JSON.parse(await readFile(`${file}.map`, "utf8"));
    } catch {
      continue;
    }
    for (const [id, source] of extractChunkModules(code, map)) {
      if (!registry.has(id)) {
        registry.set(id, source);
      }
    }
  }
  return registry;
}
