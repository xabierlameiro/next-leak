import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A Node binary the measured server will run on, with the version it reported. */
export type NodeBinary = { path: string; version: string };

/** The oldest Node the measured server can run on, the same floor as next-leak's own. */
export const MIN_SERVER_NODE_MAJOR = 22;

export class NodeBinaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeBinaryError";
  }
}

export type ReadVersion = (binary: string) => Promise<string>;

const readVersion: ReadVersion = async (binary) => {
  const { stdout } = await run(binary, ["--version"], { timeout: 10_000 });
  return stdout.trim();
};

/**
 * Checks every binary before anything is built or measured.
 *
 * A path with a typo, or a Node too old for the bootstrap's `--import`, would
 * otherwise surface as every route failing to launch, one at a time, after the
 * build. One error up front names the binary instead.
 */
export async function resolveNodeBinaries(
  paths: readonly string[],
  read: ReadVersion = readVersion
): Promise<NodeBinary[]> {
  const binaries: NodeBinary[] = [];
  for (const binary of paths) {
    let version: string;
    try {
      version = await read(binary);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new NodeBinaryError(`--node ${binary} could not be run: ${reason}`);
    }
    const match = /^v(\d+)\.\d+\.\d+/.exec(version);
    if (match === null) {
      throw new NodeBinaryError(
        `--node ${binary} did not report a Node version (got "${version.slice(0, 80)}")`
      );
    }
    if (Number(match[1]) < MIN_SERVER_NODE_MAJOR) {
      throw new NodeBinaryError(
        `--node ${binary} is ${version}; the measured server needs Node ${MIN_SERVER_NODE_MAJOR} or later`
      );
    }
    binaries.push({ path: binary, version });
  }
  return binaries;
}
