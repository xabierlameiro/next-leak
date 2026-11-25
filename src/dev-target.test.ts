import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateDevTarget } from "./dev-target.js";
import { discoverPagesRoutes, discoverRoutes } from "./manifests.js";
import { TargetError } from "./target.js";

async function app(files: readonly string[], options: { next?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "next-leak-dev-target-"));
  const all = options.next === false ? files : [...files, "node_modules/next/dist/bin/next"];
  for (const file of all) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), "");
  }
  return dir;
}

const routesOf = async (dir: string) => {
  const target = await validateDevTarget(dir);
  return [...discoverRoutes(target.appPaths), ...discoverPagesRoutes(target.pages)].map(
    (route) => `${route.kind} ${route.path}`
  );
};

describe("validateDevTarget", () => {
  it("finds the app's own Next CLI", async () => {
    const dir = await app(["app/page.jsx"]);
    const target = await validateDevTarget(dir);

    expect(target.nextBin).toBe(path.join(dir, "node_modules", "next", "dist", "bin", "next"));
    expect(target.appDir).toBe(dir);
  });

  it("refuses an app with no Next installed, and says what to do", async () => {
    const dir = await app(["app/page.jsx"], { next: false });
    const error = (await validateDevTarget(dir).catch((cause: unknown) => cause)) as TargetError;

    expect(error).toBeInstanceOf(TargetError);
    expect(error.code).toBe("NO_BUILD");
    expect(error.message).toContain("No Next.js installed");
    expect(error.message).toContain("Install the app's dependencies first");
  });

  it("maps an App Router tree to the paths a build would produce", async () => {
    // The vercel/next.js#99983 reproduction plus a group, a dynamic segment and a handler.
    const dir = await app([
      "app/layout.jsx",
      "app/page.jsx",
      "app/dynamic/page.jsx",
      "app/(shop)/cart/page.tsx",
      "app/blog/[slug]/page.tsx",
      "app/api/hello/route.ts",
      "app/dynamic/loading.jsx",
    ]);

    expect(await routesOf(dir)).toEqual([
      "page /",
      "route-handler /api/hello",
      "page /blog/[slug]",
      "page /cart",
      "page /dynamic",
    ]);
  });

  it("skips private folders and Next's special pages", async () => {
    const dir = await app([
      "app/_lib/page.tsx",
      "app/page.tsx",
      "pages/_app.tsx",
      "pages/_document.tsx",
      "pages/_error.tsx",
      "pages/legacy.tsx",
    ]);

    expect(await routesOf(dir)).toEqual(["page /", "page /legacy"]);
  });

  it("reads a Pages Router tree, index files and API routes included", async () => {
    const dir = await app(["pages/index.tsx", "pages/blog/index.tsx", "pages/blog/[slug].tsx", "pages/api/x.ts"]);

    expect(await routesOf(dir)).toEqual([
      "page /",
      "route-handler /api/x",
      "page /blog",
      "page /blog/[slug]",
    ]);
  });

  it("looks under src/ when the app keeps its routes there", async () => {
    const dir = await app(["src/app/page.tsx", "src/pages/legacy.tsx"]);

    expect(await routesOf(dir)).toEqual(["page /", "page /legacy"]);
  });

  it("ignores files that are not routes, and node_modules inside either tree", async () => {
    const dir = await app([
      "app/page.css",
      "app/page.jsx",
      "app/node_modules/x/page.js",
      "pages/README.md",
      "pages/node_modules/x/index.js",
    ]);

    expect(await routesOf(dir)).toEqual(["page /"]);
  });

  it("takes every page extension Next accepts", async () => {
    const dir = await app([
      "app/a/page.js",
      "app/b/page.jsx",
      "app/c/page.ts",
      "app/d/page.tsx",
      "app/e/page.mdx",
      "app/f/page",
    ]);

    expect(await routesOf(dir)).toEqual(["page /a", "page /b", "page /c", "page /d", "page /e"]);
  });

  it("finds nothing in an app with neither router", async () => {
    const target = await validateDevTarget(await app([]));

    expect(target.appPaths).toEqual({});
    expect(target.pages).toEqual({});
  });
});
