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

  it("exposes the error code on the class for programmatic handling", () => {
    const error = new TargetError("NO_BUILD", "boom");
    expect(error.code).toBe("NO_BUILD");
    expect(error).toBeInstanceOf(Error);
  });
});
