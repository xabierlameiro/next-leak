import type { Dirent } from "node:fs";
import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Removes the cache entries a measured server wrote, and nothing else.
 *
 * A standalone server persists every ISR render next to the build, under
 * `.next/server/app`, and fetch and image caches under `.next/cache`. With
 * `{n}` every request is a new key, so every request leaves a file: on the
 * vercel/next.js#97938 slug route each page was about 1.3 MB, and five runs
 * left some 24,000 of them, 33 GB inside the user's `.next/standalone`.
 *
 * Only what did not exist before the process started is removed. The build's
 * own prerendered pages, and anything the user put there, were listed first
 * and are kept; an entry the server rewrote in place keeps its new content,
 * which is what a revalidation in production would leave too.
 */

export type CacheListing = {
  roots: string[];
  files: Set<string>;
  dirs: Set<string>;
};

export type CleanupResult = { files: number; bytes: number };

/** The filesystem calls the cleanup makes, injectable for their failure paths. */
export type CacheFs = {
  readdir: (dir: string) => Promise<Dirent[]>;
  size: (file: string) => Promise<number>;
  unlink: (file: string) => Promise<void>;
  rmdir: (dir: string) => Promise<void>;
};

const nodeFs: CacheFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  size: async (file) => (await lstat(file)).size,
  unlink,
  rmdir,
};

const codeOf = (cause: unknown): string | undefined => (cause as NodeJS.ErrnoException).code;

/** The directories a standalone server writes its caches to. */
export function cacheRoots(serverPath: string): string[] {
  const nextDir = path.join(path.dirname(serverPath), ".next");
  return [path.join(nextDir, "server", "app"), path.join(nextDir, "cache")];
}

/**
 * Gone, or not a directory: nothing to list or remove there. Any other failure
 * stops the cleanup, because a listing with holes in it would make files that
 * were there before look new.
 */
function isMissing(cause: unknown): boolean {
  const code = codeOf(cause);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Every file and directory under `root`, without following links. */
async function walk(
  root: string,
  files: Set<string>,
  dirs: Set<string>,
  fs: CacheFs
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root);
  } catch (cause) {
    if (isMissing(cause)) {
      return;
    }
    throw cause;
  }
  dirs.add(root);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(full, files, dirs, fs);
    } else {
      files.add(full);
    }
  }
}

export async function listCache(
  roots: readonly string[],
  fs: CacheFs = nodeFs
): Promise<CacheListing> {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const root of roots) {
    await walk(root, files, dirs, fs);
  }
  return { roots: [...roots], files, dirs };
}

/** Deletes the files and directories that appeared since `before` was taken. */
export async function removeNewEntries(
  before: CacheListing,
  fs: CacheFs = nodeFs
): Promise<CleanupResult> {
  const now = await listCache(before.roots, fs);
  let files = 0;
  let bytes = 0;
  for (const file of now.files) {
    if (before.files.has(file)) {
      continue;
    }
    try {
      const size = await fs.size(file);
      await fs.unlink(file);
      files += 1;
      bytes += size;
    } catch (cause) {
      // Gone between the listing and the unlink: nothing left to remove.
      if (!isMissing(cause)) {
        throw cause;
      }
    }
  }
  // Deepest first, so a new directory is empty by the time it is reached.
  const created = [...now.dirs]
    .filter((dir) => !before.dirs.has(dir))
    .sort((a, b) => b.length - a.length);
  for (const dir of created) {
    try {
      await fs.rmdir(dir);
    } catch (cause) {
      // Something landed in it after the listing: leave it.
      if (!isMissing(cause) && codeOf(cause) !== "ENOTEMPTY") {
        throw cause;
      }
    }
  }
  return { files, bytes };
}
