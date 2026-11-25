import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { warmCompilerCache } from "./build-cache.js";

async function project(caches: Record<string, string[]>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "next-leak-build-cache-"));
  for (const [name, files] of Object.entries(caches)) {
    const cache = path.join(dir, ".next", "cache", name);
    await mkdir(cache, { recursive: true });
    for (const file of files) {
      await writeFile(path.join(cache, file), "x");
    }
  }
  return dir;
}

// vercel/next.js#100064 on 16.4.0, 2026-11-25: 7,798 MB across 108 processes
// cold, 705 MB across 4 with .next/cache/turbopack left from the run before.
describe("warmCompilerCache", () => {
  it("warns about a Turbopack cache left by an earlier build", async () => {
    const warning = await warmCompilerCache(await project({ turbopack: ["00001.sst"] }));

    expect(warning).toContain(".next/cache/turbopack holds a compiler cache");
    expect(warning).toContain("served from it rather than measured");
    expect(warning).toContain("Delete .next/cache/turbopack (not the rest of .next/cache) for a cold build");
  });

  it("warns about a webpack cache too", async () => {
    const warning = await warmCompilerCache(await project({ webpack: ["server-production"] }));

    expect(warning).toContain(".next/cache/webpack holds");
  });

  it("names both when both are warm", async () => {
    const warning = await warmCompilerCache(
      await project({ turbopack: ["a"], webpack: ["b"] })
    );

    expect(warning).toContain(".next/cache/turbopack and .next/cache/webpack hold a compiler cache");
  });

  it("stays quiet on a cold project", async () => {
    expect(await warmCompilerCache(await project({}))).toBeNull();
  });

  it("stays quiet when the cache directories are empty", async () => {
    expect(await warmCompilerCache(await project({ turbopack: [], webpack: [] }))).toBeNull();
  });

  it("ignores the rest of .next/cache", async () => {
    // The security-upgrade retry receipt lives here, and so do images and fetches.
    const dir = await project({ "next-agentic-upgrade-retries": ["247b.json"], images: ["a"] });

    expect(await warmCompilerCache(dir)).toBeNull();
  });

  it("leaves the cache where it was", async () => {
    const dir = await project({ turbopack: ["00001.sst"], "next-agentic-upgrade-retries": ["r.json"] });
    await warmCompilerCache(dir);

    expect(await readdir(path.join(dir, ".next", "cache", "turbopack"))).toEqual(["00001.sst"]);
    expect(await readdir(path.join(dir, ".next", "cache", "next-agentic-upgrade-retries"))).toEqual([
      "r.json",
    ]);
  });
});
