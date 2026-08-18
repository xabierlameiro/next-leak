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
    const redirect = result.non2xx > 0 ? await describeRedirect(options.url) : null;
    throw new LoadError(
      `${failures} of ${options.amount} requests failed against ${options.url} ` +
        `(${result.non2xx} non-2xx, ${result.errors} errors, ${result.timeouts} timeouts` +
        (unanswered > 0 ? `, ${unanswered} with no recorded response` : "") +
        ")" +
        (redirect === null ? diagnoseFailure(result, options.connections) : ` — ${redirect}`),
      result
    );
  }
  return result;
}
