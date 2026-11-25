import { access, readdir } from "node:fs/promises";
import path from "node:path";
import type { AppPathsManifest, PagesManifest } from "./manifests.js";
import { TargetError } from "./target.js";

/** What a `next dev` measurement needs: the app, its Next CLI and its routes. */
export type DevTarget = {
  appDir: string;
  /** The app's own `next` CLI entry, so the measured version is the installed one. */
  nextBin: string;
  appPaths: AppPathsManifest;
  pages: PagesManifest;
};

const PAGE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mdx"];
const APP_ENTRIES = new Set(["page", "route"]);

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function firstDir(appDir: string, candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const dir = path.join(appDir, candidate);
    if (await exists(dir)) {
      return dir;
    }
  }
  return null;
}

function routeFile(name: string): { stem: string } | null {
  const extension = path.extname(name);
  return PAGE_EXTENSIONS.includes(extension) ? { stem: name.slice(0, -extension.length) } : null;
}

/**
 * App Router entries keyed the way `app-paths-manifest.json` keys them
 * (`/dynamic/page`, `/(shop)/cart/page`, `/api/hello/route`), so the build's
 * route discovery applies unchanged. Folders starting with `_` are private and
 * never routes.
 */
async function scanApp(root: string): Promise<AppPathsManifest> {
  const manifest: AppPathsManifest = {};
  const walk = async (dir: string, segments: string[]): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith("_") && entry.name !== "node_modules") {
          await walk(path.join(dir, entry.name), [...segments, entry.name]);
        }
        continue;
      }
      const file = routeFile(entry.name);
      if (file !== null && APP_ENTRIES.has(file.stem)) {
        const key = `/${[...segments, file.stem].join("/")}`;
        manifest[key] = path.relative(path.dirname(root), path.join(dir, entry.name));
      }
    }
  };
  await walk(root, []);
  return manifest;
}

/**
 * Pages Router entries keyed by request path (`/`, `/blog/[slug]`, `/api/x`).
 * `index` maps to its folder. Next's special pages are dropped by discovery.
 */
async function scanPages(root: string): Promise<PagesManifest> {
  const manifest: PagesManifest = {};
  const walk = async (dir: string, segments: string[]): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") {
          await walk(path.join(dir, entry.name), [...segments, entry.name]);
        }
        continue;
      }
      const file = routeFile(entry.name);
      if (file === null) {
        continue;
      }
      const parts = file.stem === "index" ? segments : [...segments, file.stem];
      manifest[`/${parts.join("/")}`] = path.relative(path.dirname(root), path.join(dir, entry.name));
    }
  };
  await walk(root, []);
  return manifest;
}

/**
 * Validates an app for a `next dev` measurement.
 *
 * Nothing is built, so the routes come from source and the only requirement is
 * the app's own Next CLI: measuring a dev server with any other copy of Next
 * would measure that copy.
 */
export async function validateDevTarget(appDir: string): Promise<DevTarget> {
  const resolved = path.resolve(appDir);
  const nextBin = path.join(resolved, "node_modules", "next", "dist", "bin", "next");
  if (!(await exists(nextBin))) {
    throw new TargetError(
      "NO_BUILD",
      `No Next.js installed in ${resolved} (expected node_modules/next).\n` +
        `next-leak dev runs the app's own "next dev". Install the app's dependencies first.`
    );
  }
  const appRoot = await firstDir(resolved, ["app", path.join("src", "app")]);
  const pagesRoot = await firstDir(resolved, ["pages", path.join("src", "pages")]);
  return {
    appDir: resolved,
    nextBin,
    appPaths: appRoot === null ? {} : await scanApp(appRoot),
    pages: pagesRoot === null ? {} : await scanPages(pagesRoot),
  };
}
