import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  corpusFigures,
  evaluateCase,
  formatCorpusReport,
  loadCorpus,
  outcomeOf,
} from "./corpus.js";

const CORPUS_DIR = fileURLToPath(new URL("./__fixtures__/corpus/", import.meta.url));
const PINS_FILE = fileURLToPath(new URL("./__fixtures__/corpus/_verdicts.json", import.meta.url));

// Every real measurement with a known answer, judged by today's code. A change
// that moves any verdict fails here by name, so a classifier fix is weighed
// against every case at once instead of the one issue that prompted it.
describe("calibration corpus", async () => {
  const cases = await loadCorpus(CORPUS_DIR);
  const results = cases.map(evaluateCase);

  if (process.env["CORPUS_PIN"] === "1") {
    const pins = Object.fromEntries(results.map((result) => [result.case.id, result.verdict]));
    writeFileSync(PINS_FILE, `${JSON.stringify(pins, null, 2)}\n`);
  }
  if (process.env["CORPUS_REPORT"] === "1") {
    console.log(`\n${formatCorpusReport(results, corpusFigures(results))}\n`);
  }
  const pins = JSON.parse(readFileSync(PINS_FILE, "utf8")) as Record<string, string>;

  it("pins a verdict for every case and no other", () => {
    expect(Object.keys(pins).sort()).toEqual(cases.map((kase) => kase.id));
  });

  it.each(results.map((result) => [result.case.id, result] as const))(
    "%s keeps its pinned verdict",
    (id, result) => {
      // To accept a deliberate change: `pnpm corpus:pin`, then review the diff.
      expect(result.verdict, `${id}: pinned ${pins[id]}, now ${result.verdict}`).toBe(pins[id]);
    }
  );
});

describe("outcomeOf", () => {
  const bounded = { truth: "bounded" as const, accept: ["stable" as const, "saturating" as const] };
  const leak = { truth: "leak" as const, accept: ["leak" as const] };

  it("calls an accepted verdict correct", () => {
    expect(outcomeOf(bounded, "stable")).toBe("correct");
    expect(outcomeOf(leak, "leak")).toBe("correct");
  });

  it("calls an unaccepted leak a false leak, whatever the truth", () => {
    expect(outcomeOf(bounded, "leak")).toBe("false-leak");
    expect(outcomeOf({ truth: "healthy", accept: ["stable"] }, "leak")).toBe("false-leak");
  });

  it("calls a known leak judged otherwise missed, unless undecided", () => {
    expect(outcomeOf(leak, "stable")).toBe("missed-leak");
    expect(outcomeOf(leak, "inconclusive")).toBe("undecided");
  });

  it("calls any other mismatch the wrong class", () => {
    expect(outcomeOf(bounded, "pressure")).toBe("wrong-class");
  });
});

describe("corpusFigures", () => {
  const result = (id: string, arm: string, verdict: "leak" | "stable", outcome: "correct" | "false-leak") =>
    ({
      case: { id, arm } as never,
      verdict,
      warnings: [],
      outcome,
    });

  it("counts every kind of outcome", () => {
    const outcomes = ["correct", "false-leak", "missed-leak", "missed-leak", "undecided", "wrong-class"] as const;
    const figures = corpusFigures(
      outcomes.map((outcome, index) => ({
        case: { id: `x${index}`, arm: `x${index}` } as never,
        verdict: "stable" as const,
        warnings: [],
        outcome,
      }))
    );

    expect(figures).toMatchObject({ correct: 1, falseLeaks: 1, missedLeaks: 2, undecided: 1, wrongClass: 1 });
    expect(figures.repeatedArms).toBe(0);
  });

  it("does not count an arm whose runs agree as disagreeing", () => {
    const figures = corpusFigures([
      result("b1", "b", "leak", "correct"),
      result("b2", "b", "leak", "correct"),
      result("d1", "d", "stable", "correct"),
      result("d2", "d", "stable", "correct"),
    ]);

    expect(figures.repeatedArms).toBe(2);
    expect(figures.unstableArms).toBe(0);
  });

  it("counts outcomes and arms whose runs disagree", () => {
    const figures = corpusFigures([
      result("a1", "a", "stable", "correct"),
      result("a2", "a", "leak", "false-leak"),
      result("b1", "b", "leak", "correct"),
      result("b2", "b", "leak", "correct"),
      result("c1", "c", "stable", "correct"),
    ]);

    expect(figures).toEqual({
      cases: 5,
      correct: 4,
      falseLeaks: 1,
      missedLeaks: 0,
      undecided: 0,
      wrongClass: 0,
      repeatedArms: 2,
      unstableArms: 1,
    });
  });
});

describe("loadCorpus", () => {
  const valid = JSON.parse(
    readFileSync(fileURLToPath(new URL("./__fixtures__/corpus/97938-16.3.4-node24.json", import.meta.url)), "utf8")
  ) as Record<string, unknown>;
  const dirWith = (file: string, body: unknown): string => {
    const dir = mkdtempSync(path.join(tmpdir(), "next-leak-corpus-"));
    writeFileSync(path.join(dir, file), JSON.stringify(body));
    writeFileSync(path.join(dir, "_verdicts.json"), "{}");
    return dir;
  };

  it("loads a well-formed case and skips files starting with an underscore", async () => {
    const cases = await loadCorpus(dirWith("97938-16.3.4-node24.json", valid));

    expect(cases.map((kase) => kase.id)).toEqual(["97938-16.3.4-node24"]);
  });

  it("refuses a case whose file is not named after its id", async () => {
    await expect(loadCorpus(dirWith("other.json", valid))).rejects.toThrow("must be named after it");
  });

  it("refuses an id with characters a file name should not carry", async () => {
    await expect(loadCorpus(dirWith("Bad Id.json", { ...valid, id: "Bad Id" }))).rejects.toThrow("malformed");
    await expect(loadCorpus(dirWith("x.json", { ...valid, id: "x/" }))).rejects.toThrow("malformed");
    await expect(loadCorpus(dirWith("x.json", { ...valid, id: "/x" }))).rejects.toThrow("malformed");
  });

  it("refuses a case carrying fields the corpus never stores, such as process identity", async () => {
    await expect(
      loadCorpus(dirWith("97938-16.3.4-node24.json", { ...valid, argv: ["/home/someone/app"] }))
    ).rejects.toThrow("malformed");
  });
});
