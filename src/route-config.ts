import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * `next-leak.config.json` in the target app dir: sample values for dynamic
 * route params. `params` applies globally; `routes` overrides per route
 * template (keys as discovered, e.g. `/[lang]/candidate/[candidateId]`).
 */
/**
 * A sample value may carry `{n}` (a fresh value per request) or `{n%N}` (N
 * distinct values, revisited) — never both. Silently preferring one would make
 * the run measure a cardinality nobody asked for, and cardinality is precisely
 * what these leaks turn on.
 */
const sampleValueSchema = z.string().refine(
  (value) => !(value.includes("{n}") && /\{n%\d+\}/.test(value)),
  { message: 'a sample value cannot carry both "{n}" and "{n%N}" — pick one' }
);

const routeConfigSchema = z
  .object({
    params: z.record(z.string(), sampleValueSchema).optional(),
    routes: z.record(z.string(), z.record(z.string(), sampleValueSchema)).optional(),
    /**
     * Headers sent with every request. Real traffic is not header-less:
     * compression (`Accept-Encoding`), sessions and auth change which code
     * paths run, and some leaks only exist on those paths (zlib, per-session
     * caches). Measuring without them measures a different app.
     */
    headers: z.record(z.string(), z.string()).optional(),
    /** Query string appended per route template, e.g. `"weightKb=2048"`. */
    query: z.record(z.string(), z.string()).optional(),
    /**
     * Simulates clients that give up before the response arrives (closed
     * tabs, load-balancer timeouts, bots). Several real leaks only exist on
     * that path — vercel/next.js#89091 traces `ServerResponse` retention to
     * an early disconnect — and a load generator that always waits politely
     * never reaches it.
     *
     * Counted **from the first byte of the response**, not from the request:
     * under load a server's first byte arrives long after any sane fixed
     * window, so a request-relative clock cuts before the stream starts and
     * tests the wrong path entirely.
     */
    abandonAfterMs: z.number().int().positive().optional(),
  })
  .strict();

export type RouteConfig = z.infer<typeof routeConfigSchema>;

export class RouteConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteConfigError";
  }
}

export const ROUTE_CONFIG_FILE = "next-leak.config.json";

/** Missing file → empty config. Present but invalid → loud failure. */
export async function loadRouteConfig(appDir: string): Promise<RouteConfig> {
  const file = path.join(appDir, ROUTE_CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {};
  }
  try {
    return routeConfigSchema.parse(JSON.parse(raw));
  } catch (cause) {
    throw new RouteConfigError(
      `${file} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
}

const SEGMENT_PATTERN = /^\[(\[)?(\.\.\.)?([^\]]+?)\]?\]$/;

export type DynamicSegment = {
  name: string;
  /** `[...slug]` — the value may span several path segments. */
  catchAll: boolean;
  /** `[[...slug]]` — the segment can be omitted entirely. */
  optional: boolean;
};

/**
 * The dynamic segments of a route template, in order.
 *
 * Exported so guidance and resolution read the same grammar: a skeleton that
 * named parameters the resolver does not recognise would be worse than none.
 */
export function dynamicSegmentsOf(routeTemplate: string): DynamicSegment[] {
  const segments: DynamicSegment[] = [];
  for (const segment of routeTemplate.split("/")) {
    const match = SEGMENT_PATTERN.exec(segment);
    if (match === null) {
      continue;
    }
    segments.push({
      name: match[3] ?? "",
      catchAll: match[2] !== undefined,
      optional: match[1] !== undefined,
    });
  }
  return segments;
}

/**
 * Sample values may contain `{n}`, which the load phase replaces with a
 * per-request counter. Leaks keyed by URL (route caches, LRUs, bot traffic
 * with unique tails) are invisible when every request hits the same path.
 */
export const UNIQUE_MARKER = "{n}";

/**
 * `{n%200}` — cycle through exactly 200 distinct values, revisiting them.
 *
 * `{n}` gives every request its own URL, which is the shape of bot traffic and
 * of a cache that never repeats a key. It is not the shape the reported leaks
 * have: vercel/next.js#96533 revalidates a fixed set of 200 posts over and over,
 * and #92287 turns on how many distinct keys a cache holds at once. A bound is
 * the difference between filling a cache and growing one without limit.
 */
const BOUNDED_MARKER = /\{n%(\d+)\}/;

/** The bound in a sample value, or null when it carries none. */
export function boundedMarkerOf(value: string): { marker: string; bound: number } | null {
  const match = BOUNDED_MARKER.exec(value);
  const bound = Number(match?.[1]);
  if (match === null || !Number.isInteger(bound) || bound <= 0) {
    return null;
  }
  return { marker: match[0], bound };
}
const ENCODED_MARKER = encodeURIComponent(UNIQUE_MARKER);

/**
 * Catch-all values may span segments, so `/` survives; everything else is
 * escaped — except the load markers, which must reach the load phase intact.
 * `encodeURIComponent("{n%5}")` is `%7Bn%255%7D`, so the bounded marker needs
 * restoring too, or the app receives a literal path with a percent-escape in it
 * and every request lands on the same URL.
 */
const encodeSegment = (value: string): string =>
  restoreMarkers(encodeURIComponent(value).split(ENCODED_MARKER).join(UNIQUE_MARKER));

const ENCODED_BOUNDED = /%7Bn%25(\d+)%7D/gi;
const restoreMarkers = (value: string): string =>
  value.replace(ENCODED_BOUNDED, (_match, bound: string) => `{n%${bound}}`);
const encodeCatchAll = (value: string): string => value.split("/").map(encodeSegment).join("/");

/**
 * Substitutes sample values into a dynamic route template and returns a
 * URL-safe request path (or null when a param has no configured value;
 * optional catch-alls without a value are dropped instead).
 *
 * Percent-encoding is not cosmetic: an unencoded `#` silently truncated the
 * path (a different route got measured) and unencoded non-ASCII produced
 * requests that never completed — both verified against a real server.
 */
export function resolveRoutePath(routeTemplate: string, config: RouteConfig): string | null {
  const resolved: string[] = [];
  for (const segment of routeTemplate.split("/")) {
    const match = SEGMENT_PATTERN.exec(segment);
    if (match === null) {
      // Literal segments come from the build manifest and can be non-ASCII
      // themselves (e.g. /configuración).
      resolved.push(encodeSegment(segment));
      continue;
    }
    const optional = match[1] !== undefined;
    const catchAll = match[2] !== undefined;
    const name = match[3] ?? "";
    const value = config.routes?.[routeTemplate]?.[name] ?? config.params?.[name];
    if (value !== undefined) {
      resolved.push(catchAll ? encodeCatchAll(value) : encodeSegment(value));
    } else if (!optional) {
      return null;
    }
  }
  const joined = resolved.join("/");
  const path = joined === "" ? "/" : joined;
  const query = config.query?.[routeTemplate];
  return query === undefined || query === "" ? path : `${path}?${query}`;
}
