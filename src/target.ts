import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  appPathsManifestSchema,
  pagesManifestSchema,
  prerenderManifestSchema,
  routesManifestSchema,
  type AppPathsManifest,
  type PagesManifest,
  type PrerenderManifest,
  type RoutesManifest,
} from "./manifests.js";

export type TargetErrorCode = "NO_BUILD" | "NO_STANDALONE" | "BAD_MANIFEST";

export class TargetError extends Error {
  readonly code: TargetErrorCode;

  constructor(code: TargetErrorCode, message: string) {
    super(message);
    this.name = "TargetError";
    this.code = code;
  }
}

export type ValidatedTarget = {
  appDir: string;
  /**
   * Absolute path to the standalone `server.js`. At the root of
   * `.next/standalone` for a single-package app; under the app's path relative
   * to the workspace root for a monorepo.
   */
  standaloneServer: string;
  appPaths: AppPathsManifest;
  pages: PagesManifest;
  /** Absent on builds that do not emit it; nothing downstream reads it. */
  routes: RoutesManifest | undefined;
  /**
   * Absent on builds with nothing prerendered. Carries which routes revalidate
   * and the `previewModeId` needed to make them re-render under load.
   */
  prerender: PrerenderManifest | undefined;
};

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readManifest<T>(file: string, parse: (raw: unknown) => T): Promise<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    throw new TargetError(
      "BAD_MANIFEST",
      `Could not read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  try {
    return parse(raw);
  } catch {
    throw new TargetError(
      "BAD_MANIFEST",
      `${file} does not match the expected Next.js manifest shape. ` +
        `This Next.js version may not be supported yet.`
    );
  }
}

/**
 * Where the standalone build actually put `server.js`.
 *
 * A single-package app puts it at the root of the standalone tree. A monorepo
 * does not: Next preserves the app's path relative to the workspace root it
 * detected, so an app in `client/` ships its server at
 * `.next/standalone/client/server.js`, with `node_modules` hoisted one level
 * above it. Looking only at the root of the tree told those users their build
 * had no standalone output at all, and the only way past the message was to
 * move the tree by hand — which is what #71 did before it could run.
 *
 * That suffix is the app directory's own chain, so the candidates are
 * enumerable without walking the build: `client`, then `apps/client`, and so
 * on. A handful of `access` calls, and no guess about which `server.js` in a
 * tree full of dependencies is the right one.
 */
async function findStandaloneServer(
  appDir: string,
  standaloneDir: string
): Promise<string | undefined> {
  const atRoot = path.join(standaloneDir, "server.js");
  if (await exists(atRoot)) {
    return atRoot;
  }
  let current = path.resolve(appDir);
  let suffix = "";
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    suffix = suffix === "" ? path.basename(current) : path.join(path.basename(current), suffix);
    const candidate = path.join(standaloneDir, suffix, "server.js");
    if (await exists(candidate)) {
      return candidate;
    }
    current = parent;
  }
}

/**
 * Validates that `appDir` contains a production build with
 * `output: "standalone"` and readable route manifests. Fails fast with an
 * actionable message otherwise.
 */
export async function validateTarget(appDir: string): Promise<ValidatedTarget> {
  const nextDir = path.resolve(appDir, ".next");
  if (!(await exists(nextDir))) {
    throw new TargetError(
      "NO_BUILD",
      `No .next directory in ${appDir}. Run "next build" first.`
    );
  }

  const standaloneServer = await findStandaloneServer(appDir, path.join(nextDir, "standalone"));
  if (standaloneServer === undefined) {
    // This is the first wall every new user hits, so the message carries the
    // exact fix — three real apps needed hand-patching before this existed.
    throw new TargetError(
      "NO_STANDALONE",
      `No ${path.join(nextDir, "standalone", "server.js")}.\n` +
        `next-leak measures the standalone server bundle. Enable it once in next.config:\n\n` +
        `    const nextConfig = {\n` +
        `      output: "standalone",\n` +
        `      // ...your existing config\n` +
        `    };\n\n` +
        `then rebuild:  next build\n` +
        `This only changes how the build is packaged — not how your app behaves.`
    );
  }

  // A build has an App Router manifest, a Pages Router manifest, or both.
  // Requiring the App Router one made every Pages-only app fail with a raw
  // ENOENT, which is both wrong (server leaks are not App Router exclusive)
  // and unreadable.
  const appPathsFile = path.join(nextDir, "server", "app-paths-manifest.json");
  const pagesFile = path.join(nextDir, "server", "pages-manifest.json");
  const appPaths = (await exists(appPathsFile))
    ? await readManifest(appPathsFile, (raw) => appPathsManifestSchema.parse(raw))
    : {};
  const pages = (await exists(pagesFile))
    ? await readManifest(pagesFile, (raw) => pagesManifestSchema.parse(raw))
    : {};

  if (Object.keys(appPaths).length === 0 && Object.keys(pages).length === 0) {
    throw new TargetError(
      "BAD_MANIFEST",
      `No routes found in ${nextDir}/server: neither app-paths-manifest.json nor ` +
        `pages-manifest.json is present. Rebuild the app with "next build".`
    );
  }

  // Read only to validate the build's shape; nothing downstream consumes it.
  const routesFile = path.join(nextDir, "routes-manifest.json");
  const routes = (await exists(routesFile))
    ? await readManifest(routesFile, (raw) => routesManifestSchema.parse(raw))
    : undefined;

  // Absent on an app with nothing prerendered, which is not an error: it just
  // means no route needs driving through revalidation.
  const prerenderFile = path.join(nextDir, "prerender-manifest.json");
  const prerender = (await exists(prerenderFile))
    ? await readManifest(prerenderFile, (raw) => prerenderManifestSchema.parse(raw))
    : undefined;

  return {
    appDir: path.resolve(appDir),
    standaloneServer,
    appPaths,
    pages,
    routes,
    prerender,
  };
}
