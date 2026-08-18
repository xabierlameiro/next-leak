import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { TargetError } from "./target.js";

export type ValidatedBuildTarget = {
  appDir: string;
  /** The package script to run, when one of the usual names exists. */
  buildScript: string | null;
};

const CONFIG_NAMES = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"];

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function readPackageJson(appDir: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(path.join(appDir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * Whether the project runs static generation in threads instead of processes.
 *
 * A worker thread shares the process's resident memory, so there is nothing
 * per-worker to sample from outside — the approach this command is built on
 * simply does not apply. Next defaults this to false; a project that turns it
 * on gets told why the run cannot proceed rather than a number that would be
 * measuring the wrong thing.
 */
async function usesWorkerThreads(appDir: string): Promise<boolean> {
  for (const name of CONFIG_NAMES) {
    const file = path.join(appDir, name);
    if (!(await exists(file))) {
      continue;
    }
    const source = await readFile(file, "utf8");
    if (/workerThreads\s*:\s*true/.test(source)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates a target for a *build* measurement.
 *
 * Deliberately weaker than `validateTarget`: this command measures the build
 * itself, so demanding `.next` or a standalone bundle would reject exactly the
 * projects it exists to help — a build that OOMs never produces either.
 */
export async function validateBuildTarget(appDir: string): Promise<ValidatedBuildTarget> {
  const resolved = path.resolve(appDir);
  let entries: string[];
  try {
    entries = await readdir(resolved);
  } catch {
    throw new TargetError("NO_BUILD", `Cannot read ${resolved}.`);
  }

  const packageJson = await readPackageJson(resolved);
  const dependencies = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
  const hasNext = "next" in dependencies || entries.some((entry) => CONFIG_NAMES.includes(entry));
  if (!hasNext) {
    throw new TargetError(
      "NO_BUILD",
      `${resolved} is not a Next.js project: no "next" dependency in package.json and no next.config.\n` +
        `next-leak build measures a Next.js build. Point it at the directory holding your package.json.`
    );
  }

  if (await usesWorkerThreads(resolved)) {
    throw new TargetError(
      "NO_BUILD",
      `This project sets experimental.workerThreads: true.\n` +
        `next-leak build measures the resident memory of each static-generation worker, and a\n` +
        `worker thread has none of its own — it shares the parent's. Remove the flag (Next's\n` +
        `default) to make the build measurable.`
    );
  }

  const scripts = packageJson?.scripts ?? {};
  const buildScript = "build" in scripts ? "build" : null;
  return { appDir: resolved, buildScript };
}
