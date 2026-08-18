import { describe, expect, it } from "vitest";
import { REVALIDATE_HEADER, planRevalidation, revalidateSecondsFor, revalidates } from "./isr.js";
import { prerenderManifestSchema, type PrerenderManifest } from "./manifests.js";

// Shaped after the real prerender-manifest.json of the vercel/next.js#96533
// reproduction: 200 concrete /posts/post-N entries at 3600s, all pointing back
// at the /posts/[slug] template, which itself carries no period.
const ISR_MANIFEST: PrerenderManifest = prerenderManifestSchema.parse({
  version: 4,
  routes: {
    "/_global-error": { initialRevalidateSeconds: false, srcRoute: "/_global-error" },
    "/posts/post-0": { initialRevalidateSeconds: 3600, srcRoute: "/posts/[slug]" },
    "/posts/post-1": { initialRevalidateSeconds: 3600, srcRoute: "/posts/[slug]" },
  },
  dynamicRoutes: { "/posts/[slug]": { routeRegex: "^/posts/([^/]+?)(?:/)?$" } },
  preview: { previewModeId: "f9fe17d31dc264aa7d67957a9554580d" },
});

describe("revalidateSecondsFor", () => {
  it("finds a dynamic template's period on its concrete entries", () => {
    // The template itself carries none — this is the case that matters, and
    // reading only the template would find nothing.
    expect(revalidateSecondsFor(ISR_MANIFEST, "/posts/[slug]")).toBe(3600);
  });

  it("reads a concrete route's own period", () => {
    expect(revalidateSecondsFor(ISR_MANIFEST, "/posts/post-1")).toBe(3600);
  });

  it("treats a prerendered route that never revalidates as not ISR", () => {
    expect(revalidateSecondsFor(ISR_MANIFEST, "/_global-error")).toBeNull();
    expect(revalidates(ISR_MANIFEST, "/_global-error")).toBe(false);
  });

  it("returns null for a route the manifest does not mention", () => {
    expect(revalidateSecondsFor(ISR_MANIFEST, "/about")).toBeNull();
  });

  it("returns null when there is no manifest at all", () => {
    expect(revalidateSecondsFor(undefined, "/posts/[slug]")).toBeNull();
  });
});

describe("planRevalidation", () => {
  it("drives an ISR route with the build's own previewModeId", () => {
    const plan = planRevalidation(ISR_MANIFEST, "/posts/[slug]", undefined);
    if (plan.kind !== "drive") throw new Error("expected drive");

    expect(plan.headers[REVALIDATE_HEADER]).toBe("f9fe17d31dc264aa7d67957a9554580d");
  });

  it("adds nothing to a route that is not ISR", () => {
    const plan = planRevalidation(ISR_MANIFEST, "/about", undefined);
    expect(plan.kind).toBe("not-isr");
  });

  it("adds nothing when there is no manifest", () => {
    expect(planRevalidation(undefined, "/posts/[slug]", undefined).kind).toBe("not-isr");
  });

  it("leaves a user-supplied header untouched", () => {
    const plan = planRevalidation(ISR_MANIFEST, "/posts/[slug]", {
      [REVALIDATE_HEADER]: "mine",
    });
    if (plan.kind !== "drive") throw new Error("expected drive");

    expect(plan.headers).toEqual({});
  });

  it("matches a user-supplied header whatever its casing", () => {
    const plan = planRevalidation(ISR_MANIFEST, "/posts/[slug]", {
      "X-Prerender-Revalidate": "mine",
    });
    if (plan.kind !== "drive") throw new Error("expected drive");

    expect(plan.headers).toEqual({});
  });

  it("refuses to guess when the manifest carries no previewModeId", () => {
    // Measuring here would serve the cache and report a flat, meaningless
    // curve — the silent false negative this exists to close.
    const withoutPreview = prerenderManifestSchema.parse({
      routes: { "/posts/post-0": { initialRevalidateSeconds: 3600, srcRoute: "/posts/[slug]" } },
    });
    const plan = planRevalidation(withoutPreview, "/posts/[slug]", undefined);
    if (plan.kind !== "cannot-drive") throw new Error("expected cannot-drive");

    expect(plan.reason).toContain("3600s");
    expect(plan.reason).toContain("previewModeId");
    expect(plan.reason).toContain(REVALIDATE_HEADER);
  });
});

describe("prerenderManifestSchema", () => {
  it("tolerates the fields the tool does not read", () => {
    const parsed = prerenderManifestSchema.parse({
      version: 4,
      routes: { "/a": { initialRevalidateSeconds: 60, dataRoute: "/a.rsc", allowHeader: ["host"] } },
      notFoundRoutes: [],
      preview: { previewModeId: "x", previewModeSigningKey: "y" },
    });

    expect(parsed.routes?.["/a"]?.initialRevalidateSeconds).toBe(60);
  });

  it("accepts a manifest with no routes at all", () => {
    expect(prerenderManifestSchema.parse({ version: 4 }).routes).toBeUndefined();
  });
});

// The header the plan produces is merged under any the user set, so a bespoke
// revalidation path always wins. This is the merge the runner performs.
describe("header merge order", () => {
  it("keeps the user's value when both exist", () => {
    const plan = planRevalidation(ISR_MANIFEST, "/posts/[slug]", { [REVALIDATE_HEADER]: "mine" });
    const driven = plan.kind === "drive" ? plan.headers : {};
    const merged = { ...driven, ...{ [REVALIDATE_HEADER]: "mine" } };

    expect(merged[REVALIDATE_HEADER]).toBe("mine");
  });

  it("supplies the manifest value when the user set none", () => {
    const plan = planRevalidation(ISR_MANIFEST, "/posts/[slug]", undefined);
    const driven = plan.kind === "drive" ? plan.headers : {};
    const merged = { ...driven };

    expect(merged[REVALIDATE_HEADER]).toBe("f9fe17d31dc264aa7d67957a9554580d");
  });

  it("adds nothing for a route that is not ISR", () => {
    const plan = planRevalidation(ISR_MANIFEST, "/about", undefined);
    const driven = plan.kind === "drive" ? plan.headers : {};

    expect(Object.keys(driven)).toHaveLength(0);
  });
});
