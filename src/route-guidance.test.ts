import { describe, expect, it } from "vitest";
import { hasPlaceholders, renderConfigSkeleton, sampleValuesFromManifest } from "./route-guidance.js";
import { prerenderManifestSchema } from "./manifests.js";

// The real shape of the vercel/next.js#96533 build: concrete paths pointing
// back at their template through srcRoute.
const MANIFEST = prerenderManifestSchema.parse({
  routes: {
    "/posts/post-0": { initialRevalidateSeconds: 3600, srcRoute: "/posts/[slug]" },
    "/posts/post-1": { initialRevalidateSeconds: 3600, srcRoute: "/posts/[slug]" },
    "/docs/a/b": { initialRevalidateSeconds: 60, srcRoute: "/docs/[...path]" },
  },
  preview: { previewModeId: "x" },
});

describe("sampleValuesFromManifest", () => {
  it("lifts a real value the build already prerendered", () => {
    expect(sampleValuesFromManifest(MANIFEST, "/posts/[slug]")).toEqual({ slug: "post-0" });
  });

  it("gives a catch-all every remaining segment", () => {
    expect(sampleValuesFromManifest(MANIFEST, "/docs/[...path]")).toEqual({ path: "a/b" });
  });

  it("returns nothing for a template the build did not prerender", () => {
    expect(sampleValuesFromManifest(MANIFEST, "/users/[id]")).toBeNull();
  });

  it("returns nothing without a manifest", () => {
    expect(sampleValuesFromManifest(undefined, "/posts/[slug]")).toBeNull();
  });
});

describe("renderConfigSkeleton", () => {
  it("writes a config that resolves on the first try when the build knows a value", () => {
    const skeleton = renderConfigSkeleton(["/posts/[slug]"], MANIFEST);
    if (skeleton === null) throw new Error("expected a skeleton");

    expect(JSON.parse(skeleton)).toEqual({ routes: { "/posts/[slug]": { slug: "post-0" } } });
    expect(hasPlaceholders(skeleton)).toBe(false);
  });

  it("marks what the user has to fill in when the build knows nothing", () => {
    const skeleton = renderConfigSkeleton(["/users/[id]"], MANIFEST);
    if (skeleton === null) throw new Error("expected a skeleton");

    expect(JSON.parse(skeleton).routes["/users/[id]"].id).toBe("REPLACE-ME");
    expect(hasPlaceholders(skeleton)).toBe(true);
  });

  it("names every segment of a multi-parameter route", () => {
    const skeleton = renderConfigSkeleton(["/[lang]/candidate/[candidateId]"]);
    if (skeleton === null) throw new Error("expected a skeleton");

    expect(Object.keys(JSON.parse(skeleton).routes["/[lang]/candidate/[candidateId]"])).toEqual([
      "lang",
      "candidateId",
    ]);
  });

  it("covers several skipped routes in one file", () => {
    const skeleton = renderConfigSkeleton(["/posts/[slug]", "/users/[id]"], MANIFEST);
    if (skeleton === null) throw new Error("expected a skeleton");

    expect(Object.keys(JSON.parse(skeleton).routes)).toHaveLength(2);
  });

  it("returns nothing when no route needs configuring", () => {
    expect(renderConfigSkeleton(["/about"], MANIFEST)).toBeNull();
    expect(renderConfigSkeleton([])).toBeNull();
  });

  it("is valid JSON the user can paste unchanged", () => {
    const skeleton = renderConfigSkeleton(["/posts/[slug]"], MANIFEST);
    expect(() => JSON.parse(skeleton ?? "")).not.toThrow();
  });
});
