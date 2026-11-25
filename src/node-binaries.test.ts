import { describe, expect, it } from "vitest";
import { MIN_SERVER_NODE_MAJOR, NodeBinaryError, resolveNodeBinaries } from "./node-binaries.js";

const versions = (table: Record<string, string>) => async (binary: string) => {
  const version = table[binary];
  if (version === undefined) throw new Error(`spawn ${binary} ENOENT`);
  return version;
};

describe("resolveNodeBinaries", () => {
  it("reads each binary's version, in order", async () => {
    const binaries = await resolveNodeBinaries(
      ["/opt/node22/bin/node", "/opt/node24/bin/node"],
      versions({ "/opt/node22/bin/node": "v22.23.5", "/opt/node24/bin/node": "v24.22.3" })
    );

    expect(binaries).toEqual([
      { path: "/opt/node22/bin/node", version: "v22.23.5" },
      { path: "/opt/node24/bin/node", version: "v24.22.3" },
    ]);
  });

  it("names a binary that does not run", async () => {
    await expect(resolveNodeBinaries(["/nope/node"], versions({}))).rejects.toThrow(
      new NodeBinaryError("--node /nope/node could not be run: spawn /nope/node ENOENT")
    );
  });

  it("raises an error the CLI can tell from any other", async () => {
    const error = await resolveNodeBinaries(["/nope/node"], versions({})).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(NodeBinaryError);
    expect((error as Error).name).toBe("NodeBinaryError");
  });

  it("wants the version at the start of the output", async () => {
    await expect(
      resolveNodeBinaries(["/x"], versions({ "/x": "nodeenv wrapper for v24.0.0" }))
    ).rejects.toThrow("did not report a Node version");
  });

  it("quotes at most 80 characters of what a wrong binary printed", async () => {
    const noise = "x".repeat(200);
    const error = (await resolveNodeBinaries(["/x"], versions({ "/x": noise })).catch(
      (cause: unknown) => cause
    )) as Error;

    expect(error.message).toContain(`(got "${"x".repeat(80)}")`);
  });

  it("names a binary that is not Node", async () => {
    await expect(
      resolveNodeBinaries(["/usr/bin/python3"], versions({ "/usr/bin/python3": "Python 3.12.1" }))
    ).rejects.toThrow('--node /usr/bin/python3 did not report a Node version (got "Python 3.12.1")');
  });

  it("refuses a Node older than the floor, and accepts the floor itself", async () => {
    await expect(
      resolveNodeBinaries(["/opt/node20/bin/node"], versions({ "/opt/node20/bin/node": "v20.19.0" }))
    ).rejects.toThrow("is v20.19.0; the measured server needs Node 22 or later");

    const floor = `v${MIN_SERVER_NODE_MAJOR}.0.0`;
    await expect(resolveNodeBinaries(["/n"], versions({ "/n": floor }))).resolves.toEqual([
      { path: "/n", version: floor },
    ]);
  });

  it("reads a real binary's version", async () => {
    const [binary] = await resolveNodeBinaries([process.execPath]);

    expect(binary?.version).toBe(process.version);
  });
});
