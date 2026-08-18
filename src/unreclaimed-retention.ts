import type { HeapSample } from "./control-server.js";
import type { TrendVerdict } from "./trend.js";

const MB = 1024 * 1024;

/**
 * Memory classes compared between the two series, least to most specific.
 *
 * `arrayBuffers` is a subset of `external`, so when both are equally out of
 * proportion the later one wins the tie below — naming the narrower class says
 * more about the mechanism.
 */
const CLASSES = ["heap", "external", "arrayBuffers"] as const;

export type MemoryClass = (typeof CLASSES)[number];

export type UnreclaimedRetention = {
  /** Where holding-versus-retaining was most out of proportion. */
  class: MemoryClass;
  /** Largest per-cycle gap between what was held and what survived a GC. */
  largestGapBytes: number;
  /** What the route retained after collection, in that class. */
  retainedBytes: number;
  /** The gap as a multiple of what is retained. */
  ratio: number;
};

export type UnreclaimedRetentionInput = {
  /** One reading per cycle, taken before any forced collection. */
  unreclaimedSamples: readonly HeapSample[];
  /** Post-GC samples: baseline first, then one per cycle. */
  memorySamples: readonly HeapSample[];
  /** The route's own verdict, computed from the post-GC series. */
  verdict: TrendVerdict;
  /**
   * Whether that `leak` verdict is one the evidence plainly supports — the same
   * bar an issue draft has to clear.
   *
   * A weak `leak` must not silence this note. Measured on the #96533
   * reproduction: the post-GC verdict is `leak` at +0.15 MB/1000 req carrying
   * two low-confidence warnings, which is noise grazing the threshold, while
   * the gap is 3.96 MB of arrayBuffers at 4x what the route retains. Silencing
   * on any `leak` at all let the weaker finding hide the stronger one.
   */
  verdictIsWellSupported: boolean;
};

/**
 * The gap must clear this in absolute terms before it is worth saying.
 *
 * Measured 2026-08-18: a healthy route's largest gap is 1.9 MB. Below a floor
 * like this the note would fire on every small app, and on a route retaining
 * almost nothing the ratio below is meaningless on its own. The margin here is
 * thin — the ratio below is what actually keeps the healthy app quiet.
 */
const MIN_GAP_BYTES = 2 * MB;

/**
 * And it must be this large relative to what the route actually retains.
 *
 * The absolute floor alone does not separate the classes, and the measurements
 * say so plainly — the deliberately leaky fixture holds *more* arrayBuffers
 * between collections (4.91 MB) than the vercel/next.js#96533 reproduction does
 * (3.95 MB). What distinguishes this class is holding much more than survives a
 * collection:
 *
 * | app                      | largest heap gap | ratio |
 * |--------------------------|------------------|-------|
 * | healthy fixture route    | 1.9 MB           | 0.27x |
 * | deliberately leaky route | 5.9 MB           | 0.06x |
 * | #96533 reproduction      | 24.8 MB          | 0.89x |
 *
 * The leaky route clears the floor and fails this, correctly: its memory really
 * is retained after a GC, which is what makes it a leak rather than this.
 */
const MIN_GAP_RATIO = 0.35;

/**
 * Floor for the denominator, so a class retaining almost nothing does not
 * produce an infinite ratio. #96533 retains 0.32 MB of arrayBuffers while
 * holding 3.95 MB between collections; without this the ratio is unbounded.
 */
const MIN_RETAINED_BYTES = MB;

const read = (sample: HeapSample, memoryClass: MemoryClass): number =>
  memoryClass === "heap"
    ? sample.heapUsed
    : memoryClass === "external"
      ? sample.external
      : sample.arrayBuffers;

/**
 * The largest gap observed, which is a lower bound on what the process holds.
 *
 * Neither a mean nor a median. The pre-collection series is sampled with no
 * collection control, so a cycle where V8 happened to collect just before the
 * reading shows a gap of zero — and that says nothing about the app, only about
 * the timing of the sample. Three runs of the same #96533 reproduction:
 *
 *   run 1  3.79  0.00  4.71  4.12  3.03  5.40   median 3.96
 *   run 2                                        median 2.47
 *   run 3  0.00  1.49  0.00  0.00  3.79  0.00   median 0.00
 *
 * A median survives one collapsed cycle and not four, so on run 3 it would
 * report nothing about an app that demonstrably held 3.79 MB. A cycle that
 * *did* hold memory proves the process can; a cycle that held none proves only
 * that it had just been collected. The maximum answers the question actually
 * being asked, and understates rather than overstates: a gap larger than any
 * sampled one may well exist between samples.
 */
function largestGap(values: readonly number[]): number {
  return values.reduce((highest, value) => Math.max(highest, value), 0);
}

/** Per-cycle gaps for one memory class, pairing cycle i with cycle i. */
function gapsFor(input: UnreclaimedRetentionInput, memoryClass: MemoryClass): number[] {
  const gaps: number[] = [];
  for (const [index, held] of input.unreclaimedSamples.entries()) {
    // memorySamples[0] is the baseline, so cycle i sits at index i + 1.
    const afterGc = input.memorySamples[index + 1];
    if (afterGc === undefined) {
      break;
    }
    gaps.push(read(held, memoryClass) - read(afterGc, memoryClass));
  }
  return gaps;
}

/**
 * Whether a route holds materially more memory between collections than it
 * retains after one.
 *
 * This is the shape of vercel/next.js#96533: the reporter measured 1.16 GB of
 * arrayBuffers accumulated over four days against a flat JS heap, and named the
 * mechanism — RSC buffers rooted through a module-scope WeakMap for as long as
 * the params key object stays reachable, on a process whose full GCs are rare.
 *
 * Measured on that reproduction on 2026-08-18, the signal is a *gap*, not a
 * slope: arrayBuffers sat at 4–5 MB between collections against a flat 0.32 MB
 * after one, while the pre-collection series itself oscillated
 * (+21.2, -3.0, -6.2, +14.2 MB) and classified as `inconclusive`. An earlier
 * version of this rule keyed on that series climbing and therefore reported
 * nothing at all.
 *
 * Deliberately outside the verdict, like the peak-pressure note: `leak` /
 * `stable` / `inconclusive` are statements about what survives collection, and
 * this is a statement about what precedes it.
 *
 * Silent when the route already leaks *and* the evidence plainly supports it —
 * the retention is the headline there, and a note restating it in weaker terms
 * is noise. A marginal `leak` carrying low-confidence warnings does not silence
 * it: on the #96533 reproduction that weak verdict was hiding the finding that
 * actually names the mechanism.
 */
export function assessUnreclaimedRetention(
  input: UnreclaimedRetentionInput
): UnreclaimedRetention | null {
  if (
    (input.verdict === "leak" && input.verdictIsWellSupported) ||
    input.unreclaimedSamples.length === 0
  ) {
    return null;
  }

  let worst: UnreclaimedRetention | null = null;
  for (const memoryClass of CLASSES) {
    const gaps = gapsFor(input, memoryClass);
    if (gaps.length === 0) {
      continue;
    }
    const largestGapBytes = largestGap(gaps);
    if (largestGapBytes < MIN_GAP_BYTES) {
      continue;
    }
    const retainedBytes = largestGap(
      input.memorySamples.slice(1).map((sample) => read(sample, memoryClass))
    );
    const ratio = largestGapBytes / Math.max(retainedBytes, MIN_RETAINED_BYTES);
    if (ratio < MIN_GAP_RATIO) {
      continue;
    }
    // Report where the disproportion is largest, not where the megabytes are:
    // that is what names the mechanism.
    if (worst === null || ratio >= worst.ratio) {
      worst = { class: memoryClass, largestGapBytes, retainedBytes, ratio };
    }
  }
  return worst;
}

const mb = (bytes: number): string => `${(bytes / MB).toFixed(2)} MB`;

const CLASS_LABEL: Record<MemoryClass, string> = {
  heap: "heap",
  external: "external memory",
  arrayBuffers: "arrayBuffers",
};

/**
 * One line, phrased so it never contradicts the verdict beside it, and so it
 * states its own limit: the reading is taken seconds after load, not the hours
 * a production process runs between full collections.
 */
export function describeUnreclaimedRetention(retention: UnreclaimedRetention): string {
  return (
    `held ${mb(retention.largestGapBytes)} of ${CLASS_LABEL[retention.class]} between ` +
    `collections that a GC took back (${retention.ratio.toFixed(1)}x what it retains) — ` +
    `a forced GC reclaims this, a long-running process may not run one often ` +
    `enough to; read seconds after load, so it also includes memory not yet collected`
  );
}
