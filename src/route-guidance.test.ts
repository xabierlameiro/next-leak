import { describe, expect, it } from "vitest";
import {
  hasPlaceholders,
  renderConfigSkeleton,
  sampleValuesFromManifest,
  varyingValueFrom,
} from "./route-guidance.js";
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
  // The prerendered value gives the shape; it must not give the value, or
  // every request serves the same warm cache entry and the route reads flat.
  it("writes a config whose value moves, keeping the shape the build knows", () => {
    const skeleton = renderConfigSkeleton(["/posts/[slug]"], MANIFEST);
    if (skeleton === null) throw new Error("expected a skeleton");

    expect(JSON.parse(skeleton)).toEqual({ routes: { "/posts/[slug]": { slug: "post-{n}" } } });
    expect(hasPlaceholders(skeleton)).toBe(false);
  });

  it("never proposes a value the build already prerendered", () => {
    const skeleton = renderConfigSkeleton(["/posts/[slug]", "/docs/[...path]"], MANIFEST);
    if (skeleton === null) throw new Error("expected a skeleton");

    const { routes } = JSON.parse(skeleton) as { routes: Record<string, Record<string, string>> };
    for (const values of Object.values(routes)) {
      for (const value of Object.values(values)) {
        expect(Object.keys(MANIFEST.routes ?? {})).not.toContain(`/posts/${value}`);
        expect(value).toContain("{n}");
      }
    }
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

describe("varyingValueFrom", () => {
  // The whole point: a prerendered value measures the cache, not the route.
  it("replaces a trailing number so the prefix the app routes on survives", () => {
    expect(varyingValueFrom("post-0")).toBe("post-{n}");
    expect(varyingValueFrom("item-42")).toBe("item-{n}");
  });

  it("appends a moving tail when there is no trailing number", () => {
    expect(varyingValueFrom("seed")).toBe("seed-{n}");
  });

  it("keeps a catch-all's remaining segments addressable", () => {
    expect(varyingValueFrom("a/b")).toBe("a/b-{n}");
  });

  // A value that is nothing but digits has no prefix to preserve, so keeping
  // it whole is the only way the app still recognises the shape.
  it("does not strip a value that is only digits", () => {
    expect(varyingValueFrom("42")).toBe("42-{n}");
  });

  it("always produces a value that varies", () => {
    for (const prerendered of ["post-0", "seed", "a/b", "42", "x-1-2"]) {
      expect(varyingValueFrom(prerendered)).toContain("{n}");
    }
  });
});
