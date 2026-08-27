import autocannon from "autocannon";
import { boundedMarkerOf, UNIQUE_MARKER } from "./route-config.js";

export type LoadPhaseOptions = {
  url: string;
  /** Total number of requests to send. */
  amount: number;
  connections: number;
  /** Sent with every request (compression, cookies, auth). */
  headers?: Record<string, string>;
  /**
   * Maximum tolerated ratio of non-2xx responses plus socket errors before
   * the phase fails. A route that errors under load must fail the run, not
   * silently measure garbage. Default: 0.01 (1%).
   */
  maxErrorRatio?: number;
};

export type LoadPhaseResult = {
  sent: number;
  ok2xx: number;
  non2xx: number;
  errors: number;
  timeouts: number;
  durationSeconds: number;
};

export class LoadError extends Error {
  readonly result: LoadPhaseResult;

  constructor(message: string, result: LoadPhaseResult) {
    super(message);
    this.name = "LoadError";
    this.result = result;
  }
}

/**
 * A localized app answers `/` with a 307 to `/es`. Reporting only "non-2xx"
 * left users guessing; one extra request turns it into an instruction.
 */
async function describeRedirect(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      return `the route redirects (${response.status}) to "${location}" — measure that route instead`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether the app answers for params it never prerendered.
 *
 * A varying sample value is what makes a keyed leak visible, and on an app with
 * a closed param set (`generateStaticParams` plus `dynamicParams = false`) it is
 * also what makes every request a 404. The two look identical in the counters —
 * a wall of non-2xx — and the honest answer is not a guess: request one value
 * the marker would produce and one the app is known to serve, and compare.
 *
 * Measured on an app with `post-0..post-2` prerendered and `dynamicParams` off:
 * `/post-0` answers 200, `/post-3` answers 404. Without this probe the run told
 * the user the fault was in their route, and sent them to inspect a route that
 * was working correctly.
 *
 * Note this branch cannot occur under `cacheComponents`: Next rejects
 * `dynamicParams` at build time when it is enabled, so those apps always render
 * on demand.
 */
export async function describeUnprerenderedParams(url: string): Promise<string | null> {
  const bounded = boundedMarkerOf(url);
  const marker = bounded === null ? UNIQUE_MARKER : bounded.marker;
  if (!url.includes(marker)) {
    return null;
  }
  // A high value the build is very unlikely to have prerendered, against the
  // first one it almost certainly did.
  const probe = async (value: string): Promise<number | null> => {
    try {
      const response = await fetch(url.split(marker).join(value), { redirect: "manual" });
      return response.status;
    } catch {
      return null;
    }
  };
  const [novel, familiar] = await Promise.all([probe("999999"), probe("0")]);
  if (novel === null || familiar === null) {
    return null;
  }
  // Only a conclusion when the two disagree. Both failing means something else
  // is wrong and the route diagnosis should have its say.
  if (novel === 404 && familiar >= 200 && familiar < 300) {
    return (
      `the sample value varies per request (\`${marker}\`) and this app answers 404 ` +
      `for params it never prerendered — the route itself is fine, the value is ` +
      `the problem. Bound it to the params your build did prerender ` +
      `(\`{n%N}\` with N of them), or drop the marker and accept that every ` +
      `request serves the same cached entry`
    );
  }
  return null;
}

/**
 * Cycles a request path through exactly `bound` distinct values.
 *
 * The counter is shared across connections on purpose: what matters is how many
 * distinct keys the app sees over the phase, not which connection sent which.
 */
function boundedRequestSequence(
  fullUrl: string,
  bounded: { marker: string; bound: number }
): { origin: string; requests: Array<Record<string, unknown>> } {
  // Deliberately not `parsed.pathname`: that returns the percent-encoded form,
  // where `{n%5}` has become `%7Bn%255%7D` and the marker no longer matches.
  const parsed = new URL(fullUrl);
  const template = fullUrl.slice(parsed.origin.length);
  let counter = 0;
  return {
    origin: parsed.origin,
    requests: [
      {
        setupRequest: (request: Record<string, unknown>) => {
          const value = String(counter % bounded.bound);
          counter += 1;
          return { ...request, path: template.split(bounded.marker).join(value) };
        },
      },
    ],
  };
}

/**
 * What the failures look like, and which knob addresses them.
 *
 * A failed load phase says the run did not happen; it does not say whose fault
 * that is, and the two causes need opposite responses. Measured on the
 * vercel/next.js#97424 reproduction: 103 of 300 requests failed with 0 non-2xx
 * and 70 timeouts — the app could not serve 5 concurrent renders that each fan
 * out to 30 fetches. Reading that as "the route is broken" sends someone to
 * file a bug against their own app; reading it as saturation sends them to
 * lower the load, which is what actually gets a measurement.
 */
function diagnoseFailure(result: LoadPhaseResult, connections: number): string {
  if (result.timeouts > result.non2xx) {
    return (
      ` — the failures are timeouts rather than error responses, so the load may ` +
      `simply be more than the app or something it calls can serve; lower ` +
      `--connections (currently ${connections}) and re-run before concluding ` +
      `anything about memory`
    );
  }
  if (result.non2xx > 0) {
    return (
      ` — the app answered with errors under load, which is a fault in the route ` +
      `rather than too much traffic; fix that before measuring it`
    );
  }
  return "";
}

/** Runs one bounded load phase and fails when the error budget is exceeded. */
export async function runLoadPhase(options: LoadPhaseOptions): Promise<LoadPhaseResult> {
  // `{n}` in the path means "every request must be a distinct URL" — the only
  // way to exercise leaks keyed by URL (route caches, LRUs). autocannon does
  // this natively through `[<id>]` + idReplacement, one unique id per request.
  const unique = options.url.includes(UNIQUE_MARKER);
  const url = unique ? options.url.split(UNIQUE_MARKER).join("[<id>]") : options.url;

  // `{n%N}` needs a *bounded* set of distinct URLs, revisited across cycles —
  // the shape a real ISR cache or a keyed LRU actually has. autocannon's
  // idReplacement is unbounded by construction, so the sequence is generated
  // here instead, one path per request.
  const bounded = boundedMarkerOf(options.url);
  const boundedRequests =
    bounded === null ? undefined : boundedRequestSequence(options.url, bounded);

  const raw = await autocannon({
    url: boundedRequests === undefined ? url : boundedRequests.origin,
    amount: options.amount,
    connections: options.connections,
    ...(options.headers !== undefined && { headers: options.headers }),
    ...(unique && { idReplacement: true }),
    ...(boundedRequests !== undefined && { requests: boundedRequests.requests }),
  });

  const result: LoadPhaseResult = {
    sent: raw.requests.sent,
    ok2xx: raw["2xx"],
    non2xx: raw.non2xx,
    errors: raw.errors,
    timeouts: raw.timeouts,
    durationSeconds: raw.duration,
  };

  // Count everything that is not a recorded 2xx as a failure — not just
  // non2xx+errors. A malformed URL (e.g. an unencoded non-ASCII path) makes
  // autocannon report requests as sent with zero recorded responses, which
  // the narrower check accepted: the route was never really loaded, yet it
  // would have produced a confident "stable" verdict.
  //
  // Client abandonment deliberately has no seat here: it once did, via
  // autocannon's whole-second timeout, which cannot abandon a route that
  // answers in milliseconds and cut before the first byte besides. The
  // raw-socket phase (abandon-load.ts) is the one implementation.
  const failures = Math.max(options.amount - result.ok2xx, 0);
  const ratio = options.amount === 0 ? 0 : failures / options.amount;
  if (ratio > (options.maxErrorRatio ?? 0.01)) {
    const unanswered = failures - result.non2xx - result.errors - result.timeouts;
    // Ordered by how specific the answer is. A varying value hitting a closed
    // param set is the one cause the run can prove rather than infer, so it is
    // asked first; blaming the route is the fallback, not the default.
    const explained =
      result.non2xx > 0
        ? ((await describeUnprerenderedParams(options.url)) ??
          (await describeRedirect(options.url)))
        : null;
    throw new LoadError(
      `${failures} of ${options.amount} requests failed against ${options.url} ` +
        `(${result.non2xx} non-2xx, ${result.errors} errors, ${result.timeouts} timeouts` +
        (unanswered > 0 ? `, ${unanswered} with no recorded response` : "") +
        ")" +
        (explained === null ? diagnoseFailure(result, options.connections) : ` — ${explained}`),
      result
    );
  }
  return result;
}
