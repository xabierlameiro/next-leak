const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CHAR_TO_VALUE = new Map<string, number>([...BASE64].map((char, index) => [char, index]));

/** Decodes one line of base64-VLQ segments from a sourcemap `mappings` string. */
export function decodeVlqLine(line: string): number[][] {
  const segments: number[][] = [];
  for (const raw of line.split(",")) {
    if (raw === "") {
      continue;
    }
    const values: number[] = [];
    let value = 0;
    let shift = 0;
    for (const char of raw) {
      const digit = CHAR_TO_VALUE.get(char);
      if (digit === undefined) {
        throw new Error(`invalid VLQ character: ${char}`);
      }
      value += (digit & 0x1f) << shift;
      if ((digit & 0x20) !== 0) {
        shift += 5;
      } else {
        values.push((value & 1) === 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
    }
    segments.push(values);
  }
  return segments;
}

export type LineMapping = {
  /** Generated column → source index, sorted by column. */
  entries: Array<{ column: number; sourceIndex: number }>;
};

/**
 * Decodes a sourcemap `mappings` string into per-line column → source-index
 * tables. Only the fields attribution needs; name/line positions are dropped.
 */
export function decodeMappings(mappings: string): LineMapping[] {
  const lines: LineMapping[] = [];
  let sourceIndex = 0;
  for (const line of mappings.split(";")) {
    const entries: LineMapping["entries"] = [];
    let column = 0;
    for (const segment of decodeVlqLine(line)) {
      const columnDelta = segment[0];
      if (columnDelta === undefined) {
        continue;
      }
      column += columnDelta;
      if (segment.length >= 4) {
        sourceIndex += segment[1] ?? 0;
        entries.push({ column, sourceIndex });
      }
    }
    lines.push({ entries });
  }
  return lines;
}

/** Returns the source index active at (line, column), or undefined. */
export function sourceIndexAt(
  lines: LineMapping[],
  line: number,
  column: number
): number | undefined {
  const mapping = lines[line];
  if (mapping === undefined) {
    return undefined;
  }
  let found: number | undefined;
  for (const entry of mapping.entries) {
    if (entry.column > column) {
      break;
    }
    found = entry.sourceIndex;
  }
  return found;
}
