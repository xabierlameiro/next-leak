import { describe, expect, it } from "vitest";
import { isMeasuredChannel, spawnSpec } from "./launcher.js";

// Pure parts of the launcher, kept out of launcher.test.ts so the mutation run,
// which skips that suite's real processes, still judges them.
describe("spawnSpec", () => {
  const base = {
    serverPath: "/app/node_modules/next/dist/bin/next",
    workDir: "/tmp/run",
    appPort: 4321,
    bootstrapPath: "/opt/next-leak/dist/bootstrap.js",
    maxOldSpaceMb: 768,
  };

  it("starts next dev in the app, with the instrumentation in NODE_OPTIONS", () => {
    const spec = spawnSpec(
      { ...base, dev: { appDir: "/app" }, env: { NODE_OPTIONS: "--enable-source-maps" } },
      "127.0.0.1",
      "secret"
    );

    expect(spec.args).toEqual([base.serverPath, "dev", "-p", "4321", "-H", "127.0.0.1"]);
    expect(spec.cwd).toBe("/app");
    // The user's options first, ours after, so our heap cap is the one Next keeps.
    expect(spec.env["NODE_OPTIONS"]).toBe(
      "--enable-source-maps --expose-gc --max-old-space-size=768 --import file:///opt/next-leak/dist/bootstrap.js"
    );
    expect(spec.env["NEXT_LEAK_DIR"]).toBe("/tmp/run");
    expect(spec.env["NEXT_LEAK_TOKEN"]).toBe("secret");
    expect(spec.env["NODE_ENV"]).not.toBe("production");
  });

  it("falls back to next-leak's own NODE_OPTIONS for the dev server", () => {
    const previous = process.env["NODE_OPTIONS"];
    process.env["NODE_OPTIONS"] = "--trace-warnings";
    try {
      const spec = spawnSpec({ ...base, dev: { appDir: "/app" } }, "127.0.0.1", "t");
      expect(spec.env["NODE_OPTIONS"]?.startsWith("--trace-warnings --expose-gc")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["NODE_OPTIONS"];
      else process.env["NODE_OPTIONS"] = previous;
    }
  });

  it("starts a standalone server as before", () => {
    const spec = spawnSpec({ ...base, serverPath: "/app/.next/standalone/server.js" }, "0.0.0.0", "t");

    expect(spec.args).toEqual([
      "--expose-gc",
      "--max-old-space-size=768",
      "--import",
      "file:///opt/next-leak/dist/bootstrap.js",
      "/app/.next/standalone/server.js",
    ]);
    expect(spec.cwd).toBe("/app/.next/standalone");
    expect(spec.env["NODE_ENV"]).toBe("production");
    expect(spec.env["PORT"]).toBe("4321");
    expect(spec.env["HOSTNAME"]).toBe("0.0.0.0");
  });

  it("runs on next-leak's own Node when no binary is chosen", () => {
    expect(spawnSpec(base, "h", "t").command).toBe(process.execPath);
  });

  it("starts NODE_OPTIONS with our flags when nothing was inherited", () => {
    const previous = process.env["NODE_OPTIONS"];
    delete process.env["NODE_OPTIONS"];
    try {
      const spec = spawnSpec({ ...base, dev: { appDir: "/app" } }, "h", "t");
      expect(spec.env["NODE_OPTIONS"]?.startsWith("--expose-gc")).toBe(true);
    } finally {
      if (previous !== undefined) process.env["NODE_OPTIONS"] = previous;
    }
  });

  it("runs on the chosen Node binary in either mode", () => {
    expect(spawnSpec({ ...base, nodePath: "/opt/node22/bin/node" }, "h", "t").command).toBe(
      "/opt/node22/bin/node"
    );
    expect(
      spawnSpec({ ...base, nodePath: "/opt/node22/bin/node", dev: { appDir: "/app" } }, "h", "t").command
    ).toBe("/opt/node22/bin/node");
  });
});

describe("isMeasuredChannel", () => {
  it("takes any channel of a standalone server", () => {
    expect(isMeasuredChannel(100, 100, false)).toBe(true);
  });

  it("never takes the dev server's own CLI process", () => {
    expect(isMeasuredChannel(100, 100, true)).toBe(false);
    expect(isMeasuredChannel(101, 100, true)).toBe(true);
  });
});
