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

/**
 * Calls run per item, BATCH_SIZE at a time, one batch after the other.
 *
 * Tens of thousands of entries are normal here (24,000 pages on the #97938
 * route), and one promise per file at once is how a process runs out of file
 * descriptors. A batch keeps the filesystem busy without that.
 */
export const BATCH_SIZE = 256;

export async function inBatches<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
  size = BATCH_SIZE
): Promise<void> {
  const batches = Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );
  await batches.reduce<Promise<void>>(
    (previous, batch) => previous.then(async () => {
      await Promise.all(batch.map(run));
    }),
    Promise.resolve()
  );
}

/**
 * Every file and directory under `roots`, without following links, one level
 * of the tree at a time and each level in batches.
 */
async function walk(
  roots: readonly string[],
  files: Set<string>,
  dirs: Set<string>,
  fs: CacheFs
): Promise<void> {
  const below: string[] = [];
  await inBatches(roots, async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (cause) {
      if (isMissing(cause)) {
        return;
      }
      throw cause;
    }
    dirs.add(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        below.push(full);
      } else {
        files.add(full);
      }
    }
  });
  if (below.length > 0) {
    await walk(below, files, dirs, fs);
  }
}

export async function listCache(
  roots: readonly string[],
  fs: CacheFs = nodeFs
): Promise<CacheListing> {
  const files = new Set<string>();
  const dirs = new Set<string>();
  await walk(roots, files, dirs, fs);
  return { roots: [...roots], files, dirs };
}

const depthOf = (dir: string): number => dir.split(path.sep).length;

/** Deletes the files and directories that appeared since `before` was taken. */
export async function removeNewEntries(
  before: CacheListing,
  fs: CacheFs = nodeFs
): Promise<CleanupResult> {
  const now = await listCache(before.roots, fs);
  let files = 0;
  let bytes = 0;
  // One file that cannot go must not leave thousands that can: failures are
  // collected, the rest is removed, and the first is reported at the end.
  const failures: Error[] = [];
  const recordFailure = (cause: unknown): void => {
    failures.push(cause instanceof Error ? cause : new Error(String(cause)));
  };
  const added = [...now.files].filter((file) => !before.files.has(file));
  await inBatches(added, async (file) => {
    try {
      const size = await fs.size(file);
      await fs.unlink(file);
      files += 1;
      bytes += size;
    } catch (cause) {
      // Gone between the listing and the unlink: nothing left to remove.
      if (!isMissing(cause)) {
        recordFailure(cause);
      }
    }
  });

  // Deepest level first, so a new directory is empty by the time it is
  // reached; directories at one depth cannot contain each other.
  const byDepth = new Map<number, string[]>();
  for (const dir of now.dirs) {
    if (!before.dirs.has(dir)) {
      const depth = depthOf(dir);
      const level = byDepth.get(depth);
      if (level === undefined) {
        byDepth.set(depth, [dir]);
      } else {
        level.push(dir);
      }
    }
  }
  const levels = [...byDepth.entries()].sort(([a], [b]) => b - a).map(([, level]) => level);
  await levels.reduce<Promise<void>>(
    (previous, level) =>
      previous.then(() =>
        inBatches(level, (dir) =>
          removeDir(dir, fs).catch(recordFailure)
        )
      ),
    Promise.resolve()
  );
  const [firstFailure] = failures;
  if (firstFailure !== undefined) {
    throw new Error(
      `${failures.length} cache entr${failures.length === 1 ? "y" : "ies"} could not be removed ` +
        `(${files} removed): ${firstFailure.message}`,
      { cause: firstFailure }
    );
  }
  return { files, bytes };
}

async function removeDir(dir: string, fs: CacheFs): Promise<void> {
  try {
    await fs.rmdir(dir);
  } catch (cause) {
    // Something landed in it after the listing: leave it.
    if (!isMissing(cause) && codeOf(cause) !== "ENOTEMPTY") {
      throw cause;
    }
  }
}
