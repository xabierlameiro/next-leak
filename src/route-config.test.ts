import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadRouteConfig,
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
});
