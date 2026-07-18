import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  appPathsManifestSchema,
  pagesManifestSchema,
  routesManifestSchema,
  type AppPathsManifest,
  type PagesManifest,
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
  /** Absolute path to `.next/standalone/server.js`. */
  standaloneServer: string;
  appPaths: AppPathsManifest;
  pages: PagesManifest;
  /** Absent on builds that do not emit it; nothing downstream reads it. */
  routes: RoutesManifest | undefined;
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

  const standaloneServer = path.join(nextDir, "standalone", "server.js");
  if (!(await exists(standaloneServer))) {
    // This is the first wall every new user hits, so the message carries the
    // exact fix — three real apps needed hand-patching before this existed.
    throw new TargetError(
      "NO_STANDALONE",
      `No ${standaloneServer}.\n` +
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

  return { appDir: path.resolve(appDir), standaloneServer, appPaths, pages, routes };
}
