import { dynamicSegmentsOf } from "./route-config.js";
import type { PrerenderManifest } from "./manifests.js";

/** What to write when nothing better is known: obviously a placeholder. */
const PLACEHOLDER = "REPLACE-ME";

/**
 * Sample values lifted from paths the build actually prerendered.
 *
 * A skeleton full of placeholders still leaves the user guessing what a valid
 * value looks like. The build already knows: `prerender-manifest.json` lists
 * concrete paths, each pointing back at its template through `srcRoute`, so a
 * template like `/posts/[slug]` can be filled with a real `post-0` that will
 * resolve on the first try.
 */
export function sampleValuesFromManifest(
  manifest: PrerenderManifest | undefined,
  routeTemplate: string
): Record<string, string> | null {
  const routes = manifest?.routes;
  if (routes === undefined) {
    return null;
  }
  const concrete = Object.entries(routes).find(([, entry]) => entry.srcRoute === routeTemplate)?.[0];
  if (concrete === undefined) {
    return null;
  }

  const templateSegments = routeTemplate.split("/");
  const concreteSegments = concrete.split("/");
  const values: Record<string, string> = {};
  for (const [index, segment] of templateSegments.entries()) {
    const dynamic = dynamicSegmentsOf(segment);
    const parameter = dynamic[0];
    if (parameter === undefined) {
      continue;
    }
    // A catch-all swallows every remaining segment, so its value is the rest
    // of the concrete path rather than one segment of it.
    const value = parameter.catchAll
      ? concreteSegments.slice(index).join("/")
      : concreteSegments[index];
    if (value === undefined || value === "") {
      return null;
    }
    values[parameter.name] = value;
  }
  return Object.keys(values).length === 0 ? null : values;
}

/**
 * The `next-leak.config.json` that would measure the routes a run had to skip.
 *
 * Printed rather than merely referenced: telling someone a config file exists
 * and leaving them to work out its shape is the difference between a run they
 * can fix in ten seconds and one they abandon.
 */
export function renderConfigSkeleton(
  routeTemplates: readonly string[],
  manifest: PrerenderManifest | undefined = undefined
): string | null {
  const routes: Record<string, Record<string, string>> = {};
  for (const template of routeTemplates) {
    const segments = dynamicSegmentsOf(template);
    if (segments.length === 0) {
      continue;
    }
    const sampled = sampleValuesFromManifest(manifest, template);
    const values: Record<string, string> = {};
    for (const segment of segments) {
      values[segment.name] = sampled?.[segment.name] ?? PLACEHOLDER;
    }
    routes[template] = values;
  }
  return Object.keys(routes).length === 0 ? null : JSON.stringify({ routes }, null, 2);
}

/** Whether a rendered skeleton still needs the user to fill anything in. */
export function hasPlaceholders(skeleton: string): boolean {
  return skeleton.includes(PLACEHOLDER);
}
