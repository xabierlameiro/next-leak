import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Compiler caches Next keeps between builds. A build that finds one serves
 * compilation from it, and compilation is where vercel/next.js#97802 and
 * #100064 spend their memory.
 */
const COMPILER_CACHES = ["turbopack", "webpack"] as const;

async function holdsEntries(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

/**
 * The warning for a project whose compiler cache survived an earlier build, or
 * null when the build will compile cold.
 *
 * Warned about, never removed: the cache is the user's, and a measurement that
 * deletes files nobody asked it to touch is a worse surprise than one that
 * says what it found. Measured on the vercel/next.js#100064 reproduction on
 * 16.4.0, 2026-11-25: the same build reached 7,798 MB across 108 processes
 * cold and 705 MB across 4 with `.next/cache/turbopack` left in place.
 *
 * The advice names the compiler cache alone. The rest of `.next/cache` holds
 * Next's security-upgrade retry receipt, and deleting the whole directory
 * makes a build of an affected version stop every time it runs under an agent.
 */
export async function warmCompilerCache(appDir: string): Promise<string | null> {
  const found: string[] = [];
  for (const name of COMPILER_CACHES) {
    if (await holdsEntries(path.join(appDir, ".next", "cache", name))) {
      found.push(`.next/cache/${name}`);
    }
  }
  if (found.length === 0) {
    return null;
  }
  const subject = found.join(" and ");
  const verb = found.length === 1 ? "holds" : "hold";
  return (
    `${subject} ${verb} a compiler cache from an earlier build, so compilation may be ` +
    `served from it rather than measured. Delete ${subject} (not the rest of .next/cache) ` +
    `for a cold build`
  );
}
