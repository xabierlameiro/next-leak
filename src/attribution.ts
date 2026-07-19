import type { HeapDiff, NodeFinding } from "./heap-diff.js";
import type { ModuleRegistry } from "./module-registry.js";

export type Owner = "app" | "dependency" | "framework" | "unattributed";

export type FindingAttribution = {
  owner: Owner;
  /** Display path relative to the project (e.g. `src/app/leaky/page.tsx`). */
  source: string | null;
  packageName: string | null;
};

export type RouteAttribution = FindingAttribution & {
  /** Share of attributed retained bytes held by the winning owner+source. */
  dominance: number;
};

const UNATTRIBUTED: FindingAttribution = { owner: "unattributed", source: null, packageName: null };

/**
 * Classifies one bundler source path. Handles both real-world dialects seen
 * in Turbopack builds: `[project]/…` prefixes (Next 16.0) and URL-encoded
 * relative paths like `../../../node_modules/.pnpm/%40scope%2Bpkg@1/…`
 * (Next 16.2 sectioned maps). Exported for direct unit testing.
 */
export function classifySource(rawSource: string): FindingAttribution {
  let source = rawSource.replace(/^turbopack:\/+(?=\[)/, "");
  try {
    source = decodeURIComponent(source);
  } catch {
    // Keep the raw form; classification below still works on it.
  }
  const nodeModulesSplit = source.split("/node_modules/");
  if (nodeModulesSplit.length > 1) {
    const tail = nodeModulesSplit[nodeModulesSplit.length - 1] ?? "";
    const segments = tail.split("/");
    const packageName = (
      segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]
    ) ?? null;
    if (packageName === "next" || packageName === "react" || packageName === "react-dom") {
      return { owner: "framework", source: null, packageName };
    }
    return { owner: "dependency", source: null, packageName };
  }
  if (source.startsWith("[project]/")) {
    return { owner: "app", source: source.slice("[project]/".length), packageName: null };
  }
  const relative = source.replace(/^(\.\.\/)+/, "");
  if (relative !== source && !relative.startsWith("[")) {
    return { owner: "app", source: relative, packageName: null };
  }
  // [turbopack]/, [root-of-the-server]/, [externals]/, [next]/ — bundler and
  // framework runtime territory.
  return { owner: "framework", source: null, packageName: null };
}

const OWNER_PRIORITY: Record<Owner, number> = {
  app: 0,
  dependency: 1,
  framework: 2,
  unattributed: 3,
};

/**
 * Internals whose names appear in retainer chains even when no bundler module
 * id resolves (they live in the server runtime, not in an app chunk). Without
 * this, confirming vercel/next.js#94890 produced `unattributed` for a chain
 * that plainly ran through Next's route filesystem checker.
 *
 * Names are specific enough not to collide with user code; the component name
 * is reported so the finding says *which* internal, not just "framework".
 */
const FRAMEWORK_CHAIN_MARKERS: ReadonlyArray<readonly [marker: string, component: string]> = [
  ["fsChecker", "route filesystem checker"],
  ["getDynamicRoutes", "dynamic route matcher"],
  ["NextNodeServer", "Next server"],
  ["AppPageRouteModule", "App Router page module"],
  ["AppRouteRouteModule", "App Router route handler module"],
  ["incrementalCache", "incremental cache"],
  ["IncrementalCache", "incremental cache"],
  ["ReactServer", "React Server Components renderer"],
  ["loadManifests", "manifest loader"],
  ["renderToHTML", "HTML renderer"],
];

/** Best-effort owner for chains the module registry cannot resolve. */
export function classifyByChain(retainerChain: string): FindingAttribution | null {
  for (const [marker, component] of FRAMEWORK_CHAIN_MARKERS) {
    if (retainerChain.includes(marker)) {
      return { owner: "framework", source: null, packageName: `next (${component})` };
    }
  }
  return null;
}

/**
 * Resolves a finding's harvested module ids against the registry. When a
 * chain crosses several modules (e.g. Next's page-template wrapper retaining
 * the user's page module), the most user-actionable owner wins: app over
 * dependency over framework. Ties keep chain order (closest to the leak).
 */
export function attributeFinding(
  finding: Pick<NodeFinding, "moduleIds" | "retainerChain">,
  registry: ModuleRegistry
): FindingAttribution {
  let best: FindingAttribution = UNATTRIBUTED;
  for (const id of finding.moduleIds) {
    const source = registry.get(id);
    if (source === undefined) {
      continue;
    }
    const candidate = classifySource(source);
    if (OWNER_PRIORITY[candidate.owner] < OWNER_PRIORITY[best.owner]) {
      best = candidate;
    }
  }
  // Module ids win — they name a file. Only fall back to chain markers when
  // nothing resolved, so a real source path is never overridden by a guess.
  if (best.owner === "unattributed") {
    return classifyByChain(finding.retainerChain ?? "") ?? UNATTRIBUTED;
  }
  return best;
}

export type AttributedDiff = {
  /** Aligned with `[...diff.grownNodes, ...diff.newNodes]`. */
  findings: FindingAttribution[];
  route: RouteAttribution;
};

/**
 * Attributes every finding and derives the route-level verdict: the
 * owner+source group holding the most attributed retained bytes wins;
 * with nothing attributed the route stays `unattributed`.
 */
export function attributeDiff(diff: HeapDiff, registry: ModuleRegistry): AttributedDiff {
  const all = [...diff.grownNodes, ...diff.newNodes];
  const findings = all.map((finding) => attributeFinding(finding, registry));

  const byGroup = new Map<string, { attribution: FindingAttribution; bytes: number }>();
  let attributedBytes = 0;
  for (const [index, attribution] of findings.entries()) {
    if (attribution.owner === "unattributed") {
      continue;
    }
    const bytes = all[index]?.retainedBytes ?? 0;
    attributedBytes += bytes;
    const key = `${attribution.owner}|${attribution.source ?? ""}|${attribution.packageName ?? ""}`;
    const group = byGroup.get(key) ?? { attribution, bytes: 0 };
    group.bytes += bytes;
    byGroup.set(key, group);
  }

  let winner: { attribution: FindingAttribution; bytes: number } | null = null;
  for (const group of byGroup.values()) {
    if (winner === null || group.bytes > winner.bytes) {
      winner = group;
    }
  }

  const route: RouteAttribution =
    winner === null || attributedBytes === 0
      ? { ...UNATTRIBUTED, dominance: 0 }
      : { ...winner.attribution, dominance: winner.bytes / attributedBytes };
  return { findings, route };
}
