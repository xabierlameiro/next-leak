import autocannon from "autocannon";
import { UNIQUE_MARKER } from "./route-config.js";

export type LoadPhaseOptions = {
  url: string;
  /** Total number of requests to send. */
  amount: number;
  connections: number;
  /** Sent with every request (compression, cookies, auth). */
  headers?: Record<string, string>;
  /**
   * Give up on each request after this many milliseconds, emulating clients
   * that disconnect before the response arrives. Abandoned requests are
   * expected, so they do not count against the error budget.
   */
  abandonAfterMs?: number;
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

/** Runs one bounded load phase and fails when the error budget is exceeded. */
export async function runLoadPhase(options: LoadPhaseOptions): Promise<LoadPhaseResult> {
  // `{n}` in the path means "every request must be a distinct URL" — the only
  // way to exercise leaks keyed by URL (route caches, LRUs). autocannon does
  // this natively through `[<id>]` + idReplacement, one unique id per request.
  const unique = options.url.includes(UNIQUE_MARKER);
  const url = unique ? options.url.split(UNIQUE_MARKER).join("[<id>]") : options.url;

  const raw = await autocannon({
    url,
    amount: options.amount,
    connections: options.connections,
    ...(options.headers !== undefined && { headers: options.headers }),
    ...(options.abandonAfterMs !== undefined && {
      timeout: Math.max(Math.ceil(options.abandonAfterMs / 1000), 1),
    }),
    ...(unique && { idReplacement: true }),
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
  // When abandoning on purpose, timeouts are the point of the exercise.
  const expected = options.abandonAfterMs === undefined ? 0 : result.timeouts;
  const failures = Math.max(options.amount - result.ok2xx - expected, 0);
  const ratio = options.amount === 0 ? 0 : failures / options.amount;
  if (ratio > (options.maxErrorRatio ?? 0.01)) {
    const unanswered = failures - result.non2xx - result.errors - result.timeouts;
    const redirect = result.non2xx > 0 ? await describeRedirect(options.url) : null;
    throw new LoadError(
      `${failures} of ${options.amount} requests failed against ${options.url} ` +
        `(${result.non2xx} non-2xx, ${result.errors} errors, ${result.timeouts} timeouts` +
        (unanswered > 0 ? `, ${unanswered} with no recorded response` : "") +
        ")" +
        (redirect === null ? "" : ` — ${redirect}`),
      result
    );
  }
  return result;
}
