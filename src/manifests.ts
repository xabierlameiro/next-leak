import { z } from "zod";

/** `.next/server/app-paths-manifest.json`: app path → server bundle. */
export const appPathsManifestSchema = z.record(z.string(), z.string());
export type AppPathsManifest = z.infer<typeof appPathsManifestSchema>;

/** `.next/server/pages-manifest.json`: page path → server bundle. */
export const pagesManifestSchema = z.record(z.string(), z.string());
export type PagesManifest = z.infer<typeof pagesManifestSchema>;

const routeEntrySchema = z.looseObject({
  page: z.string(),
  regex: z.string(),
});

/** `.next/routes-manifest.json` — only the fields the tool relies on. */
export const routesManifestSchema = z.looseObject({
  version: z.number(),
  basePath: z.string(),
  staticRoutes: z.array(routeEntrySchema),
  dynamicRoutes: z.array(routeEntrySchema),
});
export type RoutesManifest = z.infer<typeof routesManifestSchema>;

export type RouteKind = "page" | "route-handler";

export type DiscoveredRoute = {
  /** Request path, e.g. "/" or "/products/[id]". */
  path: string;
  kind: RouteKind;
  /** True when the path needs sample param values before it can be requested. */
  dynamic: boolean;
  /** Set when the route exists but cannot be requested directly. */
  unaddressableReason?: string;
};

const INTERNAL_PATHS = new Set(["/_global-error", "/_not-found"]);

/** `(.)`, `(..)`, `(..)(..)`, `(...)` — Next.js intercepting-route markers. */
const INTERCEPTING_SEGMENT = /^(\(\.{1,3}\))+/;

/**
 * Turns an app-paths-manifest key into a request path: strips the trailing
 * `/page` or `/route`, route groups `(group)`, and parallel-route slots
 * `@slot`. Returns null for keys that are not requestable routes.
 */
function toRequestPath(manifestKey: string): { path: string; kind: RouteKind } | null {
  let kind: RouteKind;
  let withoutSuffix: string;
  if (manifestKey.endsWith("/page")) {
    kind = "page";
    withoutSuffix = manifestKey.slice(0, -"/page".length);
  } else if (manifestKey.endsWith("/route")) {
    kind = "route-handler";
    withoutSuffix = manifestKey.slice(0, -"/route".length);
  } else {
    return null;
  }

  const segments = withoutSuffix
    .split("/")
    .filter((segment) => segment !== "")
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .filter((segment) => !segment.startsWith("@"));

  return { path: `/${segments.join("/")}`, kind };
}

/**
 * Pages Router entries that exist in every build and are not routes a user
 * would measure: the app/document wrappers and the built-in error pages.
 */
const PAGES_INTERNAL = new Set(["/_app", "/_document", "/_error", "/404", "/500"]);

/**
 * Routes from a Pages Router build.
 *
 * Server-side leaks are not an App Router exclusive — vercel/next.js#95094
 * leaks through Pages middleware — and refusing to read this manifest made
 * next-leak fail with a raw ENOENT on any Pages-only app.
 *
 * Statically prerendered pages (`.html` bundles) are kept deliberately: they
 * still travel the server's request path, so a leak there is a real finding,
 * and dropping routes silently is worse than measuring a cheap one.
 */
export function discoverPagesRoutes(pages: PagesManifest): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const key of Object.keys(pages)) {
    if (PAGES_INTERNAL.has(key)) {
      continue;
    }
    routes.push({
      path: key,
      kind: key === "/api" || key.startsWith("/api/") ? "route-handler" : "page",
      dynamic: key.includes("["),
    });
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

export function discoverRoutes(appPaths: AppPathsManifest): DiscoveredRoute[] {
  // Parallel-route slots (@modal/page) collapse onto their parent's path
  // after stripping — keep one entry per request path.
  const routes = new Map<string, DiscoveredRoute>();
  for (const key of Object.keys(appPaths)) {
    const parsed = toRequestPath(key);
    if (parsed === null || INTERNAL_PATHS.has(parsed.path) || routes.has(parsed.path)) {
      continue;
    }
    // Intercepting routes only exist during client navigation; requesting
    // them directly 404s. Surfacing them as "failed" (which is what measuring
    // them produced) blamed the user for a Next.js routing feature.
    const intercepting = parsed.path
      .split("/")
      .some((segment) => INTERCEPTING_SEGMENT.test(segment));

    routes.set(parsed.path, {
      path: parsed.path,
      kind: parsed.kind,
      dynamic: parsed.path.includes("["),
      ...(intercepting && {
        unaddressableReason: "intercepting route — only reachable via client navigation",
      }),
    });
  }
  return [...routes.values()].sort((a, b) => a.path.localeCompare(b.path));
}
