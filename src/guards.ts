export type RuntimeFacts = {
  nodeMajor: number;
  platform: NodeJS.Platform;
};

function currentFacts(): RuntimeFacts {
  return {
    nodeMajor: Number(process.versions.node.split(".")[0]),
    platform: process.platform,
  };
}

/**
 * Startup guards — fail with an actionable message before any process is
 * spawned, instead of failing mid-run with an unrelated error.
 */
export function checkRuntime(facts: RuntimeFacts = currentFacts()): string | null {
  if (facts.platform === "win32") {
    return (
      "next-leak does not support Windows (the measurement ritual relies on " +
      "POSIX process control). Run it inside WSL2 or a Linux container."
    );
  }
  if (facts.nodeMajor < 22) {
    return (
      `next-leak needs Node.js >= 22 (you are on ${process.versions.node}). ` +
      "It relies on --expose-gc semantics and heap snapshot behavior verified " +
      "on modern V8. Upgrade Node and retry."
    );
  }
  return null;
}
