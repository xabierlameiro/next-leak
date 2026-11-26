#!/usr/bin/env node
// Turns one route of a run.json into a calibration-corpus case.
//
//   node scripts/corpus-add.mjs <run.json> --route /x --id <id> --arm <arm>
//     --truth leak|bounded|healthy --accept leak,saturating --issue 97938
//     [--note "..."]
//
// Process identity (pid, ppid, argv, cwd) and paths never enter the corpus:
// cases are committed, and those fields carry the measuring machine's layout.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const TRUTHS = new Set(["leak", "bounded", "healthy"]);
const VERDICTS = new Set(["leak", "stable", "inconclusive", "saturating", "pressure"]);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    route: { type: "string" },
    id: { type: "string" },
    arm: { type: "string" },
    truth: { type: "string" },
    accept: { type: "string" },
    issue: { type: "string" },
    note: { type: "string", default: "" },
  },
});

const fail = (message) => {
  console.error(`corpus-add: ${message}`);
  process.exit(1);
};

const [runFile] = positionals;
if (runFile === undefined) fail("give the run.json to read");
for (const required of ["route", "id", "arm", "truth", "accept", "issue"]) {
  if (values[required] === undefined) fail(`--${required} is required`);
}
if (!TRUTHS.has(values.truth)) fail(`--truth must be one of ${[...TRUTHS].join(", ")}`);
const accept = values.accept.split(",").map((verdict) => verdict.trim());
for (const verdict of accept) {
  if (!VERDICTS.has(verdict)) fail(`--accept has an unknown verdict "${verdict}"`);
}
if (!/^[a-z0-9.-]+$/.test(values.id)) fail("--id must be lowercase letters, digits, dots and dashes");

const run = JSON.parse(readFileSync(runFile, "utf8"));
const route = run.routes.find((entry) => entry.route === values.route);
if (route === undefined) fail(`no route ${values.route} in ${runFile}`);
if (route.status !== "measured") fail(`route ${values.route} is ${route.status}, not measured`);

const sample = ({ gcExposed, heapUsed, rss, external, arrayBuffers }) => ({
  gcExposed,
  heapUsed,
  rss,
  external,
  arrayBuffers,
});

const kase = {
  id: values.id,
  arm: values.arm,
  issue: `vercel/next.js#${values.issue}`,
  next: run.environment.nextVersion,
  node: run.environment.nodeVersion,
  mode: run.server === "dev" ? "dev" : "server",
  route: values.route,
  measuredOn: run.startedAt.slice(0, 10),
  truth: values.truth,
  accept,
  ...(values.note !== "" && { note: values.note }),
  reported: route.confidence.supersededVerdict ?? route.trend.verdict,
  input: {
    memorySamples: route.memorySamples.map(sample),
    peaks: route.peaks,
    requestsPerCycle: route.requestsPerCycle,
    maxOldSpaceMb: run.parameters.maxOldSpaceMb,
    warmupRequests: run.parameters.warmupRequests,
    loadOutcomes: route.loadOutcomes,
    settleOutcomes: route.settleOutcomes,
    ...(route.trend.cacheDriven === true && { cacheDriven: true }),
    ...(route.servedFromIsrCache === true && { revalidatesFromCache: true }),
  },
};

const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "__fixtures__",
  "corpus",
  `${values.id}.json`
);
writeFileSync(out, `${JSON.stringify(kase, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), out)} (${kase.reported}, truth ${kase.truth})`);
