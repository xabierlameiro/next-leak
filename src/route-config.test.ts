import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  boundedMarkerOf,
  loadRouteConfig,
  mixesMarkers,
  probeRequestPath,
  resolveRoutePath,
  ROUTE_CONFIG_FILE,
  RouteConfigError,
} from "./route-config.js";

describe("loadRouteConfig", () => {
  it("returns an empty config when no file exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "next-leak-config-"));
    expect(await loadRouteConfig(dir)).toEqual({});
  });

  it("loads and validates a config file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "next-leak-config-"));
    await writeFile(
      path.join(dir, ROUTE_CONFIG_FILE),
      JSON.stringify({ params: { lang: "en" }, routes: { "/[lang]/x/[id]": { id: "7" } } })
    );
    expect((await loadRouteConfig(dir)).params).toEqual({ lang: "en" });
  });

  it("fails loudly on invalid JSON or unknown keys", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "next-leak-config-"));
    await writeFile(path.join(dir, ROUTE_CONFIG_FILE), "{nope");
    await expect(loadRouteConfig(dir)).rejects.toBeInstanceOf(RouteConfigError);
    await writeFile(path.join(dir, ROUTE_CONFIG_FILE), JSON.stringify({ typo: {} }));
    await expect(loadRouteConfig(dir)).rejects.toBeInstanceOf(RouteConfigError);
  });
});

describe("resolveRoutePath", () => {
  const config = {
    params: { lang: "en" },
    routes: { "/[lang]/candidate/[candidateId]": { candidateId: "abc123" } },
  };

  it("substitutes global params", () => {
    expect(resolveRoutePath("/[lang]/dashboard", config)).toBe("/en/dashboard");
  });

  it("prefers per-route values over globals", () => {
    expect(resolveRoutePath("/[lang]/candidate/[candidateId]", config)).toBe(
      "/en/candidate/abc123"
    );
  });

  it("returns null when a param has no value", () => {
    expect(resolveRoutePath("/[lang]/share/[shareId]", config)).toBeNull();
  });

  it("substitutes catch-alls and drops valueless optional catch-alls", () => {
    expect(resolveRoutePath("/docs/[...slug]", { params: { slug: "intro" } })).toBe("/docs/intro");
    expect(resolveRoutePath("/docs/[[...slug]]", {})).toBe("/docs");
    expect(resolveRoutePath("/docs/[...slug]", {})).toBeNull();
  });

  it("leaves static routes untouched", () => {
    expect(resolveRoutePath("/plain", {})).toBe("/plain");
    expect(resolveRoutePath("/", {})).toBe("/");
  });

  // Regression: unencoded values produced requests that measured the wrong
  // route (a `#` truncates the path) or never completed at all (non-ASCII).
  it("percent-encodes param values", () => {
    const encode = (value: string) => resolveRoutePath("/p/[id]", { params: { id: value } });
    expect(encode("hola mundo")).toBe("/p/hola%20mundo");
    expect(encode("a#b")).toBe("/p/a%23b");
    expect(encode("x?y=1")).toBe("/p/x%3Fy%3D1");
    expect(encode("camión")).toBe("/p/cami%C3%B3n");
    // Path traversal cannot escape the segment it was substituted into.
    expect(encode("../../etc/passwd")).toBe("/p/..%2F..%2Fetc%2Fpasswd");
  });

  it("percent-encodes non-ASCII literal segments from the manifest", () => {
    expect(resolveRoutePath("/configuración", {})).toBe("/configuraci%C3%B3n");
  });

  it("keeps slashes inside catch-all values while encoding each segment", () => {
    expect(resolveRoutePath("/docs/[...slug]", { params: { slug: "guía/año 1" } })).toBe(
      "/docs/gu%C3%ADa/a%C3%B1o%201"
    );
  });
});

describe("unique URL marker", () => {
  it("preserves {n} through percent-encoding so the load phase can vary it", () => {
    expect(resolveRoutePath("/logs/[id]", { params: { id: "item-{n}" } })).toBe("/logs/item-{n}");
    // Everything else in the same value is still encoded.
    expect(resolveRoutePath("/logs/[id]", { params: { id: "año {n}" } })).toBe("/logs/a%C3%B1o%20{n}");
  });
});

describe("headers in config", () => {
  it("accepts a headers map", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "next-leak-config-"));
    await writeFile(
      path.join(dir, ROUTE_CONFIG_FILE),
      JSON.stringify({ headers: { "accept-encoding": "gzip", cookie: "session=x" } })
    );
    const config = await loadRouteConfig(dir);
    expect(config.headers).toEqual({ "accept-encoding": "gzip", cookie: "session=x" });
  });
});

describe("query strings and client abandonment", () => {
  it("appends a per-route query string after the resolved path", () => {
    const config = {
      routes: { "/api/payload/[slug]": { slug: "item-{n}" } },
      query: { "/api/payload/[slug]": "weightKb=2048" },
    };
    expect(resolveRoutePath("/api/payload/[slug]", config)).toBe(
      "/api/payload/item-{n}?weightKb=2048"
    );
  });

  it("leaves the path untouched when no query is configured for it", () => {
    expect(resolveRoutePath("/a", { query: { "/b": "x=1" } })).toBe("/a");
    expect(resolveRoutePath("/a", { query: { "/a": "" } })).toBe("/a");
  });

  it("accepts abandonAfterMs and rejects nonsense values", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "next-leak-config-"));
    await writeFile(path.join(dir, ROUTE_CONFIG_FILE), JSON.stringify({ abandonAfterMs: 50 }));
    expect((await loadRouteConfig(dir)).abandonAfterMs).toBe(50);
    await writeFile(path.join(dir, ROUTE_CONFIG_FILE), JSON.stringify({ abandonAfterMs: -5 }));
    await expect(loadRouteConfig(dir)).rejects.toBeInstanceOf(RouteConfigError);
  });

  it("reads abandonFrom and defaults it to nothing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "next-leak-config-"));
    await writeFile(
      path.join(dir, ROUTE_CONFIG_FILE),
      JSON.stringify({ abandonAfterMs: 60, abandonFrom: "request" })
    );
    expect((await loadRouteConfig(dir)).abandonFrom).toBe("request");

    await writeFile(path.join(dir, ROUTE_CONFIG_FILE), JSON.stringify({ abandonAfterMs: 60 }));
    expect((await loadRouteConfig(dir)).abandonFrom).toBeUndefined();
  });

  it("rejects an unknown origin and one with no deadline to anchor", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "next-leak-config-"));
    await writeFile(
      path.join(dir, ROUTE_CONFIG_FILE),
      JSON.stringify({ abandonAfterMs: 60, abandonFrom: "connect" })
    );
    await expect(loadRouteConfig(dir)).rejects.toBeInstanceOf(RouteConfigError);

    // An origin with no deadline configures nothing, so it is a mistake worth
    // naming rather than a no-op to swallow.
    await writeFile(
      path.join(dir, ROUTE_CONFIG_FILE),
      JSON.stringify({ abandonFrom: "request" })
    );
    await expect(loadRouteConfig(dir)).rejects.toBeInstanceOf(RouteConfigError);
  });
});

// `{n}` is unbounded by construction; the reported leaks turn on a fixed set of
// keys revisited instead — #96533 revalidates the same 200 posts over and over.
describe("bounded cardinality marker", () => {
  it("reads the bound out of a sample value", () => {
    expect(boundedMarkerOf("post-{n%200}")).toEqual({ marker: "{n%200}", bound: 200 });
  });

  it("reads nothing from an unbounded value", () => {
    expect(boundedMarkerOf("post-{n}")).toBeNull();
    expect(boundedMarkerOf("post-1")).toBeNull();
  });

  it("ignores a bound that is not a positive integer", () => {
    expect(boundedMarkerOf("post-{n%0}")).toBeNull();
  });

  it("survives the percent-encoding that resolution applies", () => {
    // encodeURIComponent turns `{n%5}` into `%7Bn%255%7D`; if that reached the
    // load phase every request would hit the same literal path.
    const resolved = resolveRoutePath("/posts/[slug]", {
      routes: { "/posts/[slug]": { slug: "post-{n%5}" } },
    });

    expect(resolved).toBe("/posts/post-{n%5}");
  });

  it("rejects a value carrying both markers, before any measurement starts", async () => {
    // Silently preferring one would make the run measure a cardinality nobody
    // asked for, and cardinality is exactly what these leaks turn on.
    const dir = await mkdtemp(path.join(tmpdir(), "next-leak-cfg-"));
    await writeFile(
      path.join(dir, ROUTE_CONFIG_FILE),
      JSON.stringify({ params: { slug: "post-{n}-{n%10}" } })
    );

    await expect(loadRouteConfig(dir)).rejects.toBeInstanceOf(RouteConfigError);
    await expect(loadRouteConfig(dir)).rejects.toThrow(/cannot carry both/);
  });
});

// The readiness probe asks for the route about to be measured. Sent with its
// markers intact it asks for a literal `{n}`, planting a key in the route's
// cache that no request of the run ever revisits — before the baseline
// snapshot is taken.
describe("probeRequestPath", () => {
  it("resolves the unique marker to a value the build likely prerendered", () => {
    expect(probeRequestPath("/posts/post-{n}")).toBe("/posts/post-0");
  });

  it("resolves the bounded marker, which the load sequence visits too", () => {
    expect(probeRequestPath("/posts/post-{n%50}")).toBe("/posts/post-0");
  });

  it("resolves every marker in a path, not just the first", () => {
    expect(probeRequestPath("/{n}/post-{n}")).toBe("/0/post-0");
  });

  it("leaves a path without markers alone, query string included", () => {
    expect(probeRequestPath("/posts/post-1?draft=1")).toBe("/posts/post-1?draft=1");
  });
});

// A single value carrying both markers is rejected when the config loads, but
// two params of the same route can each carry a different one. The load phase
// resolves the bounded marker and leaves `{n}` in the path as a literal, so
// those requests would ask for a URL with `%7Bn%7D` in it.
describe("mixesMarkers", () => {
  it("catches the two markers arriving from different params", () => {
    expect(mixesMarkers("/a/v-{n}/b/w-{n%5}")).toBe(true);
    expect(mixesMarkers("/a/v-{n%5}/b/w-{n}")).toBe(true);
  });

  it("passes a path that picks one cardinality", () => {
    expect(mixesMarkers("/a/v-{n}/b/fixed")).toBe(false);
    expect(mixesMarkers("/a/v-{n%5}/b/fixed")).toBe(false);
    expect(mixesMarkers("/a/fixed")).toBe(false);
  });

  it("is the shape resolveRoutePath actually produces", () => {
    const resolved = resolveRoutePath("/[lang]/posts/[slug]", {
      routes: { "/[lang]/posts/[slug]": { lang: "es-{n%3}", slug: "post-{n}" } },
    });

    expect(resolved).toBe("/es-{n%3}/posts/post-{n}");
    expect(mixesMarkers(resolved ?? "")).toBe(true);
  });
});
