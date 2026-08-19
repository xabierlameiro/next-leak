import net from "node:net";

/**
 * Where the abandon deadline starts. `first-byte` puts the cut mid-stream
 * whatever the route's latency; `request` puts it before the response exists,
 * which is a different leak path and not reachable from the other origin.
 */
export type AbandonOrigin = "first-byte" | "request";

export type AbandonPhaseOptions = {
  url: string;
  amount: number;
  connections: number;
  /** Destroy the socket this many ms after the origin below. */
  abandonAfterMs: number;
  /** Defaults to `first-byte`. */
  abandonFrom?: AbandonOrigin;
  headers?: Record<string, string>;
};

export type AbandonPhaseResult = {
  sent: number;
  abandoned: number;
  /**
   * Abandonments where the server had already started responding. Only these
   * exercise mid-stream teardown; cutting before the first byte tests a
   * different path (the server may never have begun rendering).
   */
  abandonedMidStream: number;
  /** Abandonments where the first-byte budget expired in silence. */
  abandonedBeforeResponse: number;
  completed: number;
  errors: number;
};

/**
 * How long a request waits for its first byte before being written off.
 *
 * Only reached by routes that are not answering, so its exact value matters
 * little; it exists so one hung route cannot stall a phase forever. Deliberately
 * not a flag — `--help` is not the place to explain what to do about a server
 * that sends nothing for five seconds.
 */
const FIRST_BYTE_BUDGET_MS = 5000;

/**
 * Sends requests and hangs up before the response arrives.
 *
 * autocannon cannot express this: its `timeout` is in whole seconds, so
 * against a route answering in milliseconds nothing is ever abandoned. Yet
 * several real leaks live exactly on that path — vercel/next.js#89091 traces
 * `ServerResponse` retention to an early disconnect, which only happens when
 * a client goes away mid-flight (closed tabs, load-balancer timeouts, bots).
 *
 * Raw sockets keep this honest: write the request, wait for the response to
 * start, then wait `abandonAfterMs` and destroy the socket mid-stream. With
 * `abandonFrom: "request"` the wait starts at the write instead, which is the
 * only way to cut a route that has not begun answering yet.
 */
export async function runAbandonPhase(
  options: AbandonPhaseOptions
): Promise<AbandonPhaseResult> {
  const target = new URL(options.url);
  const port = Number(target.port || 80);
  const fromRequest = options.abandonFrom === "request";
  const headerLines = Object.entries(options.headers ?? {})
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  const request =
    `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
    `Host: ${target.host}\r\n` +
    headerLines +
    `Connection: close\r\n\r\n`;

  const result: AbandonPhaseResult = {
    sent: 0,
    abandoned: 0,
    abandonedMidStream: 0,
    abandonedBeforeResponse: 0,
    completed: 0,
    errors: 0,
  };
  let remaining = options.amount;

  const sendOne = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const socket = net.connect({ host: target.hostname, port });
      let settled = false;
      let responseStarted = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve();
      };
      const giveUp = (): void => {
        if (!settled) {
          result.abandoned += 1;
          if (responseStarted) {
            result.abandonedMidStream += 1;
          } else {
            result.abandonedBeforeResponse += 1;
          }
        }
        finish();
      };

      // Under the default origin only the first-byte budget is armed here. An
      // earlier version always started the abandon window on connect, which
      // raced the server's first byte — and under load the server lost that
      // race almost every time: measured against the vercel/next.js#94919
      // repro, 2 of ~1500 cuts per cycle landed mid-stream. That is why the
      // window starts where the stream does unless a route asks otherwise,
      // and why asking is per route rather than a default.
      socket.once("connect", () => {
        result.sent += 1;
        socket.write(request);
        timer = setTimeout(
          giveUp,
          fromRequest ? options.abandonAfterMs : FIRST_BYTE_BUDGET_MS
        );
        timer.unref();
      });
      // Receiving bytes is not the end of the experiment, it is the start of
      // the interesting part: a client that reads a chunk and then vanishes
      // leaves the server mid-stream, which is where stream-shaped leaks live
      // (vercel/next.js#94919 retains the RSC tee branch exactly there).
      socket.on("data", () => {
        if (responseStarted) {
          return;
        }
        responseStarted = true;
        // Under the request origin the deadline is already running from the
        // write and must not be restarted here, or a route that answers just
        // inside it would get a second full window and never be cut.
        if (fromRequest) {
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(giveUp, options.abandonAfterMs);
        timer.unref();
      });
      socket.once("end", () => {
        // The server finished the response before the timer fired.
        if (!settled) {
          result.completed += 1;
        }
        finish();
      });
      socket.once("error", () => {
        if (!settled) {
          result.errors += 1;
        }
        finish();
      });
    });

  const worker = async (): Promise<void> => {
    while (remaining > 0) {
      remaining -= 1;
      await sendOne();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.connections, options.amount) }, () => worker())
  );
  return result;
}
