import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { judgeMeasurement, type JudgeInput } from "./judge.js";
import type { TrendVerdict } from "./trend.js";

const VERDICTS = ["leak", "stable", "inconclusive", "saturating", "pressure"] as const;

const sampleSchema = z.object({
  gcExposed: z.boolean(),
  heapUsed: z.number(),
  rss: z.number(),
  external: z.number(),
  arrayBuffers: z.number(),
});

/** A real measurement whose right answer is known, as `scripts/corpus-add.mjs` writes it. */
export const corpusCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9.-]+$/),
  /** Repeated measurements of the same build, versions and route share an arm. */
  arm: z.string(),
  issue: z.string(),
  next: z.string().nullable(),
  node: z.string(),
  mode: z.enum(["server", "dev"]),
  route: z.string(),
  measuredOn: z.string(),
  truth: z.enum(["leak", "bounded", "healthy"]),
  accept: z.array(z.enum(VERDICTS)).min(1),
  note: z.string().optional(),
  /** What the tool reported when the case was measured, for history only. */
  reported: z.enum(VERDICTS),
  input: z.strictObject({
    memorySamples: z.array(sampleSchema).min(2),
    peaks: z.array(
      z.object({
        phase: z.string(),
        heapUsed: z.number(),
        external: z.number(),
        arrayBuffers: z.number(),
        rss: z.number(),
        polls: z.number(),
      })
    ),
    requestsPerCycle: z.number().positive(),
    maxOldSpaceMb: z.number().positive(),
    warmupRequests: z.number().nonnegative(),
    loadOutcomes: z.array(
      z.object({
        phase: z.string(),
        sent: z.number(),
        ok2xx: z.number().optional(),
        non2xx: z.number().optional(),
        errors: z.number().optional(),
        timeouts: z.number().optional(),
        abandoned: z.number().optional(),
        abandonedMidStream: z.number().optional(),
        abandonedBeforeResponse: z.number().optional(),
      })
    ),
    settleOutcomes: z.array(
      z.object({
        phase: z.string(),
        status: z.enum(["settled", "moving", "unknown"]),
        polls: z.number(),
      })
    ),
    cacheDriven: z.literal(true).optional(),
    revalidatesFromCache: z.literal(true).optional(),
  }),
});

export type CorpusCase = z.infer<typeof corpusCaseSchema>;

/** How a verdict fares against the case's known answer. */
export type Outcome = "correct" | "false-leak" | "missed-leak" | "undecided" | "wrong-class";

export type CaseResult = {
  case: CorpusCase;
  verdict: TrendVerdict;
  warnings: string[];
  outcome: Outcome;
};

export type CorpusFigures = {
  cases: number;
  correct: number;
  falseLeaks: number;
  missedLeaks: number;
  undecided: number;
  wrongClass: number;
  /** Arms measured more than once. */
  repeatedArms: number;
  /** Of those, the ones whose runs did not all get the same verdict. */
  unstableArms: number;
};

export async function loadCorpus(dir: string): Promise<CorpusCase[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json") && !file.startsWith("_"));
  const cases = await Promise.all(
    files.map(async (file) => {
      const parsed = corpusCaseSchema.safeParse(JSON.parse(await readFile(path.join(dir, file), "utf8")));
      if (!parsed.success) {
        throw new Error(`corpus case ${file} is malformed: ${parsed.error.message}`);
      }
      if (`${parsed.data.id}.json` !== file) {
        throw new Error(`corpus case ${file} carries id "${parsed.data.id}"; the file must be named after it`);
      }
      return parsed.data;
    })
  );
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Classifies a verdict against the answer. A `leak` that is not accepted is a
 * false leak whatever the truth, because an accusation is the expensive error.
 * A known leak called anything else is missed, unless the tool said it could
 * not decide.
 */
export function outcomeOf(kase: Pick<CorpusCase, "truth" | "accept">, verdict: TrendVerdict): Outcome {
  if (kase.accept.includes(verdict)) {
    return "correct";
  }
  if (verdict === "leak") {
    return "false-leak";
  }
  if (verdict === "inconclusive") {
    return "undecided";
  }
  return kase.truth === "leak" ? "missed-leak" : "wrong-class";
}

/** Judges a stored measurement with today's code. */
export function evaluateCase(kase: CorpusCase): CaseResult {
  // Parsed JSON never carries a key set to undefined, which is the only gap
  // between zod's optional fields and the exact optional ones JudgeInput uses.
  const judgement = judgeMeasurement(kase.input as unknown as JudgeInput);
  return {
    case: kase,
    verdict: judgement.verdict,
    warnings: judgement.confidence.warnings.map((warning) => warning.code),
    outcome: outcomeOf(kase, judgement.verdict),
  };
}

export function corpusFigures(results: readonly CaseResult[]): CorpusFigures {
  const count = (outcome: Outcome): number =>
    results.filter((result) => result.outcome === outcome).length;
  const byArm = new Map<string, Set<TrendVerdict>>();
  const runs = new Map<string, number>();
  for (const result of results) {
    const verdicts = byArm.get(result.case.arm) ?? new Set<TrendVerdict>();
    verdicts.add(result.verdict);
    byArm.set(result.case.arm, verdicts);
    runs.set(result.case.arm, (runs.get(result.case.arm) ?? 0) + 1);
  }
  const repeated = [...runs].filter(([, n]) => n > 1).map(([arm]) => arm);
  return {
    cases: results.length,
    correct: count("correct"),
    falseLeaks: count("false-leak"),
    missedLeaks: count("missed-leak"),
    undecided: count("undecided"),
    wrongClass: count("wrong-class"),
    repeatedArms: repeated.length,
    unstableArms: repeated.filter((arm) => (byArm.get(arm)?.size ?? 0) > 1).length,
  };
}

const share = (part: number, whole: number): string =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(0)}%`;

/** The table and figures `pnpm corpus` prints. */
export function formatCorpusReport(results: readonly CaseResult[], figures: CorpusFigures): string {
  const width = Math.max(...results.map((result) => result.case.id.length), 4);
  const rows = results.map(
    (result) =>
      `${result.case.id.padEnd(width)}  ${result.case.truth.padEnd(7)}  ${result.verdict.padEnd(12)}  ` +
      `${result.outcome.padEnd(11)}  ${result.warnings.join(",")}`
  );
  return [
    `${"case".padEnd(width)}  truth    verdict       outcome      warnings`,
    ...rows,
    "",
    `cases ${figures.cases} · correct ${figures.correct} (${share(figures.correct, figures.cases)})`,
    `false leaks ${figures.falseLeaks} (${share(figures.falseLeaks, figures.cases)}) · ` +
      `missed leaks ${figures.missedLeaks} · undecided ${figures.undecided} · wrong class ${figures.wrongClass}`,
    `arms run more than once ${figures.repeatedArms} · disagreeing ${figures.unstableArms} ` +
      `(${share(figures.unstableArms, figures.repeatedArms)})`,
  ].join("\n");
}
