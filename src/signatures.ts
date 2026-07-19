import { readFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { z } from "zod";
import type { HeapDiff } from "./heap-diff.js";

const signatureSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    nextRange: z.string().refine((range) => semver.validRange(range) !== null, {
      message: "invalid semver range",
    }),
    cause: z.string().min(1),
    issue: z.url(),
    /** True when the leak is already fixed upstream — still valuable for old deployments. */
    historical: z.boolean(),
    match: z
      .object({
        chainIncludes: z.string().min(1).optional(),
        typeDeltaAbove: z.object({ type: z.string(), bytes: z.number() }).optional(),
      })
      .refine((match) => match.chainIncludes !== undefined || match.typeDeltaAbove !== undefined, {
        message: "a signature needs at least one match rule",
      }),
  })
  .strict();

export type Signature = z.infer<typeof signatureSchema>;

/**
 * Known-cause catalog. Data only, validated at load time, and deliberately
 * conservative: patterns are documented best-effort from the source issues
 * and matching is always additionally gated by the app's Next.js version.
 */
const RAW_SIGNATURES: unknown[] = [
  {
    id: "standalone-fetch-undici-retention",
    title: "fetch() response retention in standalone output",
    nextRange: ">=15.0.0 <16.1.0",
    cause:
      "Server-side fetch under load retained response memory (undici/external " +
      "buffers) in output: standalone deployments. Fixed upstream via " +
      "Node/undici updates.",
    issue: "https://github.com/vercel/next.js/issues/90433",
    historical: true,
    // The issue's symptom is retained response buffers, not undici objects in
    // chains — chain matching on "undici" false-positives on any standalone
    // app under keep-alive load (observed in the 5.2 gate run).
    match: { typeDeltaAbove: { type: "ArrayBuffer", bytes: 2 * 1024 * 1024 } },
  },
  {
    id: "rsc-render-tree-per-request",
    title: "RSC render tree retained per request",
    nextRange: ">=15.0.0 <17.0.0",
    cause:
      "App Router RSC render trees retained per request leading to OOM in " +
      "non-standalone deployments.",
    issue: "https://github.com/vercel/next.js/issues/94919",
    historical: false,
    match: { chainIncludes: "ReactServer" },
  },
];

export function loadSignatures(raw: unknown[] = RAW_SIGNATURES): Signature[] {
  return raw.map((entry) => signatureSchema.parse(entry));
}

export type MatchedSignature = Pick<Signature, "id" | "title" | "cause" | "issue" | "historical">;

/**
 * Matches signatures against a diff, gated by the measured app's Next.js
 * version. Unknown version or no matching range → no annotations, no errors.
 */
export function matchSignatures(
  diff: HeapDiff,
  nextVersion: string | null,
  signatures: Signature[] = loadSignatures()
): MatchedSignature[] {
  if (nextVersion === null) {
    return [];
  }
  const version = semver.coerce(nextVersion);
  if (version === null) {
    return [];
  }

  const chains = [...diff.grownNodes, ...diff.newNodes].map((finding) => finding.retainerChain);
  const matched: MatchedSignature[] = [];
  for (const signature of signatures) {
    if (!semver.satisfies(version, signature.nextRange)) {
      continue;
    }
    const byChain =
      signature.match.chainIncludes !== undefined &&
      chains.some((chain) => chain.includes(signature.match.chainIncludes ?? ""));
    const rule = signature.match.typeDeltaAbove;
    const byTypeDelta =
      rule !== undefined &&
      diff.typeDeltas.some((delta) => delta.type === rule.type && delta.deltaBytes >= rule.bytes);
    if (byChain || byTypeDelta) {
      matched.push({
        id: signature.id,
        title: signature.title,
        cause: signature.cause,
        issue: signature.issue,
        historical: signature.historical,
      });
    }
  }
  return matched;
}

/** Reads the measured app's Next.js version from its standalone bundle. */
export async function readNextVersion(appDir: string): Promise<string | null> {
  const candidates = [
    path.join(appDir, ".next", "standalone", "node_modules", "next", "package.json"),
    path.join(appDir, "node_modules", "next", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = z
        .object({ version: z.string() })
        .parse(JSON.parse(await readFile(candidate, "utf8")));
      return parsed.version;
    } catch {
      continue;
    }
  }
  return null;
}
