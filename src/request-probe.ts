import type { Server } from "node:net";
import { requestProbe } from "./control-server.js";

/**
 * Wraps a module's `createServer` so every server it hands out counts the
 * requests it serves.
 *
 * Its own module rather than a helper inside `bootstrap.ts`, because the
 * bootstrap is an entry point that runs on import and lands inside the
 * *measured* process — where no coverage instrumentation reaches it, and where
 * a mistake is only visible as a run whose numbers came from a process that
 * served nothing.
 *
 * `http.createServer` and `https.createServer` have different signatures, so
 * there is no shared type to borrow. Only the return value is touched, and the
 * arguments are forwarded untyped and unchanged.
 */
export function countServedRequests<
  T extends { createServer: (...args: never[]) => Server },
>(module: T): void {
  const original = module.createServer;
  module.createServer = function patched(this: unknown, ...args: never[]): Server {
    const server = original.apply(this, args);
    server.on("request", () => {
      requestProbe.__nextLeakServedRequests = (requestProbe.__nextLeakServedRequests ?? 0) + 1;
    });
    return server;
  };
}
