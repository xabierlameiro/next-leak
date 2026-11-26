import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheRoots, inBatches, listCache, removeNewEntries, type CacheFs } from "./isr-cleanup.js";

let standalone: string;
let app: string;
let cache: string;

beforeEach(async () => {
  standalone = await mkdtemp(path.join(tmpdir(), "next-leak-isr-"));
  app = path.join(standalone, ".next", "server", "app");
  cache = path.join(standalone, ".next", "cache");
  await mkdir(path.join(app, "blog"), { recursive: true });
  // What the build prerendered, and something the user keeps there.
  await writeFile(path.join(app, "blog", "first.html"), "built");
  await writeFile(path.join(app, "index.html"), "built");
});

afterEach(async () => {
  await rm(standalone, { recursive: true, force: true });
});

describe("cacheRoots", () => {
  it("is the app cache and the fetch/image cache beside server.js", () => {
    expect(cacheRoots("/x/.next/standalone/client/server.js")).toEqual([
      "/x/.next/standalone/client/.next/server/app",
      "/x/.next/standalone/client/.next/cache",
    ]);
  });
});

describe("removeNewEntries", () => {
  it("removes what the server wrote and keeps what the build had", async () => {
    const before = await listCache(cacheRoots(path.join(standalone, "server.js")));
    // An ISR render per unique key, a nested route, and a fetch cache entry.
    await writeFile(path.join(app, "seed-1.html"), "x".repeat(1000));
    await writeFile(path.join(app, "seed-1.meta"), "y".repeat(24));
    await mkdir(path.join(app, "blog", "seed-2"), { recursive: true });
    await writeFile(path.join(app, "blog", "seed-2", "page.html"), "z".repeat(100));
    await mkdir(path.join(cache, "fetch-cache"), { recursive: true });
    await writeFile(path.join(cache, "fetch-cache", "abc"), "f");

    expect(await removeNewEntries(before)).toEqual({ files: 4, bytes: 1125 });
    expect((await readdir(app)).sort()).toEqual(["blog", "index.html"]);
    expect(await readdir(path.join(app, "blog"))).toEqual(["first.html"]);
    // The cache directory did not exist before: it goes too.
    await expect(readdir(cache)).rejects.toThrow();
  });

  it("keeps an entry the server rewrote in place", async () => {
    const before = await listCache(cacheRoots(path.join(standalone, "server.js")));
    await writeFile(path.join(app, "index.html"), "revalidated");

    expect(await removeNewEntries(before)).toEqual({ files: 0, bytes: 0 });
    expect(await readFile(path.join(app, "index.html"), "utf8")).toBe("revalidated");
  });

  it("keeps a directory that existed before, even emptied", async () => {
    await mkdir(path.join(cache, "images"), { recursive: true });
    const before = await listCache(cacheRoots(path.join(standalone, "server.js")));
    await writeFile(path.join(cache, "images", "a.webp"), "i");

    await removeNewEntries(before);
    expect(await readdir(path.join(cache, "images"))).toEqual([]);
  });

  it("removes a link the server made without following it", async () => {
    const outside = path.join(standalone, "outside.txt");
    await writeFile(outside, "not ours");
    const before = await listCache(cacheRoots(path.join(standalone, "server.js")));
    await symlink(outside, path.join(app, "link"));

    expect((await removeNewEntries(before)).files).toBe(1);
    expect(await readFile(outside, "utf8")).toBe("not ours");
  });

  it("does nothing when neither directory exists", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "next-leak-isr-empty-"));
    const before = await listCache(cacheRoots(path.join(empty, "server.js")));
    expect(before.files.size + before.dirs.size).toBe(0);
    expect(await removeNewEntries(before)).toEqual({ files: 0, bytes: 0 });
    await rm(empty, { recursive: true, force: true });
  });

  it("does not follow a linked directory into what it points at", async () => {
    const elsewhere = path.join(standalone, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, "keep.html"), "keep");
    await symlink(elsewhere, path.join(app, "linked"));
    const before = await listCache(cacheRoots(path.join(standalone, "server.js")));
    await writeFile(path.join(elsewhere, "new.html"), "new");

    // Not under the cache roots once links are not followed: left alone.
    expect(await removeNewEntries(before)).toEqual({ files: 0, bytes: 0 });
    expect((await readdir(elsewhere)).sort()).toEqual(["keep.html", "new.html"]);
  });
});

const failure = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: fake`), { code });

/** A tree of one root holding `names`, plus whatever `overrides` replace. */
function fakeFs(names: string[], overrides: Partial<CacheFs> = {}): CacheFs {
  const entry = (name: string) => ({ name, isDirectory: () => false });
  return {
    readdir: async (dir) => {
      if (dir !== "/root") throw failure("ENOENT");
      return names.map(entry) as never;
    },
    size: async () => 10,
    unlink: async () => {},
    rmdir: async () => {},
    ...overrides,
  };
}

describe("removeNewEntries when the filesystem misbehaves", () => {
  it("treats a root that is a file as no cache at all", async () => {
    const listing = await listCache(["/root"], fakeFs([], { readdir: async () => { throw failure("ENOTDIR"); } }));
    expect(listing.dirs.size).toBe(0);
  });

  it("refuses to list through a directory it cannot read", async () => {
    // A hole in the first listing would make what was there look new.
    await expect(
      listCache(["/root"], fakeFs([], { readdir: async () => { throw failure("EACCES"); } }))
    ).rejects.toThrow("EACCES");
  });

  it("skips a file that vanished before it was removed, and counts only what it removed", async () => {
    const before = { roots: ["/root"], files: new Set<string>(), dirs: new Set(["/root"]) };
    const fs = fakeFs(["a", "b"], {
      unlink: async (file) => {
        if (file.endsWith("a")) throw failure("ENOENT");
      },
    });
    expect(await removeNewEntries(before, fs)).toEqual({ files: 1, bytes: 10 });
  });

  it("stops on any other failure to remove a file", async () => {
    const before = { roots: ["/root"], files: new Set<string>(), dirs: new Set(["/root"]) };
    const fs = fakeFs(["a"], { unlink: async () => { throw failure("EPERM"); } });
    await expect(removeNewEntries(before, fs)).rejects.toThrow("EPERM");
  });

  it("leaves a new directory something landed in, or that is already gone", async () => {
    const before = { roots: ["/root"], files: new Set<string>(), dirs: new Set<string>() };
    for (const code of ["ENOTEMPTY", "ENOENT"]) {
      const fs = fakeFs([], { rmdir: async () => { throw failure(code); } });
      expect(await removeNewEntries(before, fs)).toEqual({ files: 0, bytes: 0 });
    }
  });

  it("stops on any other failure to remove a directory", async () => {
    const before = { roots: ["/root"], files: new Set<string>(), dirs: new Set<string>() };
    const fs = fakeFs([], { rmdir: async () => { throw failure("EBUSY"); } });
    await expect(removeNewEntries(before, fs)).rejects.toThrow("EBUSY");
  });
});

describe("inBatches", () => {
  it("runs every item, never more than a batch at once, batches in order", async () => {
    let running = 0;
    let most = 0;
    const order: number[] = [];
    await inBatches(
      [1, 2, 3, 4, 5, 6, 7],
      async (item) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, item % 2));
        order.push(item);
        running -= 1;
      },
      3
    );
    expect(most).toBe(3);
    expect(order.slice(0, 3).sort()).toEqual([1, 2, 3]);
    expect(order.slice(3, 6).sort()).toEqual([4, 5, 6]);
    expect(order[6]).toBe(7);
  });

  it("does nothing for no items, and stops at the first failure", async () => {
    await inBatches([], async () => {
      throw new Error("never called");
    });
    const seen: number[] = [];
    await expect(
      inBatches(
        [1, 2, 3],
        async (item) => {
          seen.push(item);
          if (item === 1) throw new Error("first batch failed");
        },
        1
      )
    ).rejects.toThrow("first batch failed");
    expect(seen).toEqual([1]);
  });
});

describe("removeNewEntries over a deep tree", () => {
  it("removes thousands of entries and the nested directories they made", async () => {
    const before = await listCache(cacheRoots(path.join(standalone, "server.js")));
    // The shape of a slug route: a page, its metadata and a segments directory per key.
    for (let n = 0; n < 600; n += 1) {
      await writeFile(path.join(app, `seed-${n}.html`), "x");
      await mkdir(path.join(app, `seed-${n}.segments`, "deep", "deeper"), { recursive: true });
      await writeFile(path.join(app, `seed-${n}.segments`, "deep", "deeper", "s.rsc"), "y");
    }

    expect((await removeNewEntries(before)).files).toBe(1200);
    expect((await readdir(app)).sort()).toEqual(["blog", "index.html"]);
  });
});
