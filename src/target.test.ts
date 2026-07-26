import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TargetError, validateTarget } from "./target.js";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);

async function makeAppDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "next-leak-test-"));
}

async function makeValidBuild(appDir: string): Promise<void> {
  await mkdir(path.join(appDir, ".next", "standalone"), { recursive: true });
  await mkdir(path.join(appDir, ".next", "server"), { recursive: true });
  await writeFile(path.join(appDir, ".next", "standalone", "server.js"), "// stub\n");
  await cp(
    new URL("app-paths-manifest.json", FIXTURES),
    path.join(appDir, ".next", "server", "app-paths-manifest.json")
  );
  await cp(
    new URL("routes-manifest.json", FIXTURES),
    path.join(appDir, ".next", "routes-manifest.json")
  );
}

describe("validateTarget", () => {
  it("fails with NO_BUILD when there is no .next directory", async () => {
    const appDir = await makeAppDir();
    await expect(validateTarget(appDir)).rejects.toMatchObject({
      name: "TargetError",
      code: "NO_BUILD",
    });
  });

  it("walks the user through enabling standalone output, verbatim", async () => {
    // This is the first wall every new user hits: the message IS the product
    // there, and every clause of it is load-bearing — the config snippet, the
    // rebuild step, and the reassurance that packaging is all that changes.
    const appDir = await makeAppDir();
    await mkdir(path.join(appDir, ".next"), { recursive: true });
    const failure = await validateTarget(appDir).catch((cause: TargetError) => cause);
    expect(failure).toBeInstanceOf(TargetError);
    const message = (failure as TargetError).message;
    expect(message).toContain('output: "standalone"');
    expect(message).toContain("// ...your existing config");
    expect(message).toContain("then rebuild:  next build");
    expect(message).toContain("not how your app behaves");
    expect(message).toContain(path.join(".next", "standalone", "server.js"));
  });

  it("fails with NO_STANDALONE when the standalone server is missing", async () => {
    const appDir = await makeAppDir();
    await mkdir(path.join(appDir, ".next"), { recursive: true });
    await expect(validateTarget(appDir)).rejects.toMatchObject({ code: "NO_STANDALONE" });
  });

  it("fails with BAD_MANIFEST on unreadable or invalid manifests", async () => {
    const appDir = await makeAppDir();
    await makeValidBuild(appDir);
    await writeFile(
      path.join(appDir, ".next", "server", "app-paths-manifest.json"),
      "not json at all"
    );
    await expect(validateTarget(appDir)).rejects.toMatchObject({ code: "BAD_MANIFEST" });
  });

  it("returns parsed manifests and absolute paths for a valid build", async () => {
    const appDir = await makeAppDir();
    await makeValidBuild(appDir);
    const target = await validateTarget(appDir);
    expect(target.standaloneServer).toBe(
      path.join(path.resolve(appDir), ".next", "standalone", "server.js")
    );
    expect(target.appPaths["/page"]).toBe("app/page.js");
    expect(target.routes?.version).toBe(3);
  });

  it("accepts a Pages-only build — server leaks are not App Router exclusive", async () => {
    // Validated end to end against the vercel/next.js#95094 reproduction
    // (Pages Router + middleware), but the unit suite never touched the
    // branch: 11 of target.ts's mutants sat in it with no coverage at all.
    const appDir = await makeAppDir();
    await mkdir(path.join(appDir, ".next", "standalone"), { recursive: true });
    await mkdir(path.join(appDir, ".next", "server"), { recursive: true });
    await writeFile(path.join(appDir, ".next", "standalone", "server.js"), "// stub\n");
    await writeFile(
      path.join(appDir, ".next", "server", "pages-manifest.json"),
      JSON.stringify({ "/about": "pages/about.js", "/api/heap": "pages/api/heap.js" })
    );

    const target = await validateTarget(appDir);
    expect(Object.keys(target.pages)).toEqual(["/about", "/api/heap"]);
    expect(target.appPaths).toEqual({});
  });

  it("names both missing manifests when a build has neither", async () => {
    const appDir = await makeAppDir();
    await mkdir(path.join(appDir, ".next", "standalone"), { recursive: true });
    await mkdir(path.join(appDir, ".next", "server"), { recursive: true });
    await writeFile(path.join(appDir, ".next", "standalone", "server.js"), "// stub\n");

    const failure = await validateTarget(appDir).catch((cause: TargetError) => cause);
    expect(failure).toBeInstanceOf(TargetError);
    expect((failure as TargetError).code).toBe("BAD_MANIFEST");
    const message = (failure as TargetError).message;
    expect(message).toContain("app-paths-manifest.json");
    expect(message).toContain("pages-manifest.json");
    expect(message).toContain('"next build"');
  });

  it("exposes the error code on the class for programmatic handling", () => {
    const error = new TargetError("NO_BUILD", "boom");
    expect(error.code).toBe("NO_BUILD");
    expect(error).toBeInstanceOf(Error);
  });
});
