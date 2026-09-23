import type { PrerenderManifest } from "./manifests.js";
import { boundedMarkerOf, UNIQUE_MARKER } from "./route-config.js";

/**
 * Whether the load asks for a key the route has never served, every time.
 *
 * `{n%N}` is deliberately excluded: its key set is bounded, so from the second
 * pass on the load hits entries the cache already holds and needs driving to
 * reach the renderer at all.
 */
function keysAreNewEveryRequest(requestPath: string): boolean {
  return requestPath.includes(UNIQUE_MARKER) && boundedMarkerOf(requestPath) === null;
}

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
  /** ISR, but every request asks for a key the cache has never held. */
  | { kind: "no-cache-to-drive" }
  /** ISR, but the manifest cannot supply what an authentic request needs. */
  | { kind: "cannot-drive"; reason: string };

/**
 * How to make a route re-render, given what the build tells us.
 *
 * A header the user set themselves wins untouched: someone driving a bespoke
 * revalidation path knows more about it than the manifest does.
 *
 * `requestPath` decides whether driving is needed at all. The header does not
 * merely bypass the cache: it makes Next serve the request through its
 * revalidation path instead of its normal one, and a route whose render count
 * depends on the normal path is then measured somewhere its users never go.
 * Measured on the vercel/next.js#99077 reproduction: with the header, the
 * `partialPrefetching: true` and `false` builds both created 1.95 timers per
 * request and were reported at the same +1970 MB/1000 req; without it they
 * created 3.80 and 0.99 and separated 5x, matching the issue. So the header is
 * sent only where it buys something — when the load revisits keys the cache
 * can already hold. With `{n}` every request carries a key the route has never
 * served, so there is no cache to bypass and driving only distorts.
 */
export function planRevalidation(
  manifest: PrerenderManifest | undefined,
  route: string,
  userHeaders: Record<string, string> | undefined,
  requestPath?: string
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
  if (requestPath !== undefined && keysAreNewEveryRequest(requestPath)) {
    return { kind: "no-cache-to-drive" };
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
