import type { PrerenderManifest } from "./manifests.js";

/**
 * The header Next accepts as an authentic revalidation request.
 *
 * Sent with the build's own `previewModeId`, it makes the server re-render the
 * page instead of serving the cached one. Without it, load against an ISR route
 * exercises the static cache and nothing else — measured on the
 * vercel/next.js#96533 reproduction, the same app reports `leak` with this
 * header and `stable` without it.
 */
export const REVALIDATE_HEADER = "x-prerender-revalidate";

/**
 * The revalidation period in force for a route, or null when it has none.
 *
 * Accepts either a concrete path (`/posts/post-1`) or a dynamic template
 * (`/posts/[slug]`): the period lives on concrete entries, and a template
 * inherits it from any entry whose `srcRoute` points back at it.
 */
export function revalidateSecondsFor(
  manifest: PrerenderManifest | undefined,
  route: string
): number | null {
  const routes = manifest?.routes;
  if (routes === undefined) {
    return null;
  }
  const direct = routes[route]?.initialRevalidateSeconds;
  if (typeof direct === "number") {
    return direct;
  }
  for (const entry of Object.values(routes)) {
    if (entry.srcRoute === route && typeof entry.initialRevalidateSeconds === "number") {
      return entry.initialRevalidateSeconds;
    }
  }
  return null;
}

/** Whether a route is served from the ISR cache and needs driving. */
export function revalidates(manifest: PrerenderManifest | undefined, route: string): boolean {
  return revalidateSecondsFor(manifest, route) !== null;
}

export type RevalidationPlan =
  | { kind: "not-isr" }
  | { kind: "drive"; headers: Record<string, string> }
  /** ISR, but the manifest cannot supply what an authentic request needs. */
  | { kind: "cannot-drive"; reason: string };

/**
 * How to make a route re-render, given what the build tells us.
 *
 * A header the user set themselves wins untouched: someone driving a bespoke
 * revalidation path knows more about it than the manifest does.
 */
export function planRevalidation(
  manifest: PrerenderManifest | undefined,
  route: string,
  userHeaders: Record<string, string> | undefined
): RevalidationPlan {
  const userSupplied = Object.keys(userHeaders ?? {}).some(
    (name) => name.toLowerCase() === REVALIDATE_HEADER
  );
  if (userSupplied) {
    return { kind: "drive", headers: {} };
  }
  if (!revalidates(manifest, route)) {
    return { kind: "not-isr" };
  }
  const previewModeId = manifest?.preview?.previewModeId;
  if (previewModeId === undefined || previewModeId === "") {
    return {
      kind: "cannot-drive",
      reason:
        `revalidates every ${revalidateSecondsFor(manifest, route)}s, but the build's ` +
        `prerender-manifest.json carries no previewModeId — load would serve the cache ` +
        `and measure nothing. Set "${REVALIDATE_HEADER}" in next-leak.config.json to drive it.`,
    };
  }
  return { kind: "drive", headers: { [REVALIDATE_HEADER]: previewModeId } };
}
