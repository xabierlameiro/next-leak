import net from "node:net";

export type AbandonPhaseOptions = {
  url: string;
  amount: number;
  connections: number;
  /** Destroy the socket this many ms after sending the request. */
  abandonAfterMs: number;
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
  completed: number;
  errors: number;
};

/**
 * Sends requests and hangs up before the response arrives.
 *
 * autocannon cannot express this: its `timeout` is in whole seconds, so
 * against a route answering in milliseconds nothing is ever abandoned. Yet
 * several real leaks live exactly on that path — vercel/next.js#89091 traces
 * `ServerResponse` retention to an early disconnect, which only happens when
 * a client goes away mid-flight (closed tabs, load-balancer timeouts, bots).
 *
 * Raw sockets keep this honest: write the request, wait `abandonAfterMs`,
 * destroy the socket. No response is read.
 */
export async function runAbandonPhase(
  options: AbandonPhaseOptions
): Promise<AbandonPhaseResult> {
  const target = new URL(options.url);
  const port = Number(target.port || 80);
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
    completed: 0,
    errors: 0,
  };
  let remaining = options.amount;

  const worker = async (): Promise<void> => {
    while (remaining > 0) {
      remaining -= 1;
      await new Promise<void>((resolve) => {
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

        // The clock starts when the request is on the wire, not when the
        // socket is created: under concurrency the connect itself can take
        // longer than the abandon window, and a request never sent teaches
        // the server nothing.
        socket.once("connect", () => {
          result.sent += 1;
          socket.write(request);
          timer = setTimeout(() => {
            if (!settled) {
              result.abandoned += 1;
              if (responseStarted) {
                result.abandonedMidStream += 1;
              }
            }
            finish();
          }, options.abandonAfterMs);
          timer.unref();
        });
        // Receiving bytes is not the end of the experiment, it is the start of
        // the interesting part: a client that reads a chunk and then vanishes
        // leaves the server mid-stream, which is where stream-shaped leaks
        // live (vercel/next.js#94919 retains the RSC tee branch exactly
        // there). Closing on the first byte made that case inexpressible.
        socket.on("data", () => {
          responseStarted = true;
        });
        socket.once("end", () => {
          // The server finished the response before the timer fired.
          if (!settled) {
            result.completed += 1;
          }
          clearTimeout(timer);
          finish();
        });
        socket.once("error", () => {
          if (!settled) {
            result.errors += 1;
          }
          clearTimeout(timer);
          finish();
        });
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.connections, options.amount) }, () => worker())
  );
  return result;
}
