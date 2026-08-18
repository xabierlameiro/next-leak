import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateBuildTarget } from "./build-target.js";
import { TargetError } from "./target.js";

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "next-leak-build-target-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

describe("validateBuildTarget", () => {
  it("accepts a project that has never been built", async () => {
    // Producing .next is the thing being measured: demanding it up front would
    // reject exactly the builds that OOM before writing anything.
    const dir = await makeProject({
      "package.json": JSON.stringify({ dependencies: { next: "16.3.1" }, scripts: { build: "next build" } }),
    });
    const target = await validateBuildTarget(dir);

    expect(target.appDir).toBe(path.resolve(dir));
    expect(target.buildScript).toBe("build");
  });

  it("accepts a project identified only by its next.config", async () => {
    const dir = await makeProject({ "next.config.mjs": "export default {}\n" });
    await expect(validateBuildTarget(dir)).resolves.toBeDefined();
  });

  it("reports no build script rather than assuming one", async () => {
    const dir = await makeProject({
      "package.json": JSON.stringify({ dependencies: { next: "16.3.1" } }),
    });
    expect((await validateBuildTarget(dir)).buildScript).toBeNull();
  });

  it("rejects a directory that is not a Next.js project", async () => {
    const dir = await makeProject({ "package.json": JSON.stringify({ dependencies: {} }) });
    await expect(validateBuildTarget(dir)).rejects.toThrow(/not a Next\.js project/);
  });

  it("rejects a directory it cannot read", async () => {
    await expect(validateBuildTarget("/nope/not/here")).rejects.toThrow(TargetError);
  });

  it("refuses worker threads, explaining why they cannot be sampled", async () => {
    // A thread shares the parent's resident memory, so there is nothing
    // per-worker to measure from outside.
    const dir = await makeProject({
      "package.json": JSON.stringify({ dependencies: { next: "16.3.1" } }),
      "next.config.mjs": "export default { experimental: { workerThreads: true } }\n",
    });

    await expect(validateBuildTarget(dir)).rejects.toThrow(/workerThreads/);
    await expect(validateBuildTarget(dir)).rejects.toThrow(/has none of its own/);
  });

  it("accepts a project that turns worker threads off explicitly", async () => {
    const dir = await makeProject({
      "package.json": JSON.stringify({ dependencies: { next: "16.3.1" } }),
      "next.config.mjs": "export default { experimental: { workerThreads: false } }\n",
    });
    await expect(validateBuildTarget(dir)).resolves.toBeDefined();
  });
});
