import { EventEmitter } from "node:events";
import type { Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { requestProbe } from "./control-server.js";
import { countServedRequests } from "./request-probe.js";

/** A server is only an event emitter as far as the probe is concerned. */
const fakeServer = (): Server => new EventEmitter() as unknown as Server;

afterEach(() => {
  delete requestProbe.__nextLeakServedRequests;
});

describe("countServedRequests", () => {
  it("counts one per request the server emits", () => {
    const module = { createServer: (): Server => fakeServer() };
    countServedRequests(module);

    const server = module.createServer();
    server.emit("request");
    server.emit("request");

    expect(requestProbe.__nextLeakServedRequests).toBe(2);
  });

  it("starts from zero rather than skipping the first request", () => {
    const module = { createServer: (): Server => fakeServer() };
    countServedRequests(module);

    module.createServer().emit("request");

    expect(requestProbe.__nextLeakServedRequests).toBe(1);
  });

  it("counts across every server the module hands out", () => {
    const module = { createServer: (): Server => fakeServer() };
    countServedRequests(module);

    module.createServer().emit("request");
    module.createServer().emit("request");

    expect(requestProbe.__nextLeakServedRequests).toBe(2);
  });

  it("returns the server the original created, untouched", () => {
    const original = fakeServer();
    const module = { createServer: (): Server => original };
    countServedRequests(module);

    expect(module.createServer()).toBe(original);
  });

  // The host app's own arguments — its request handler, its options — have to
  // arrive unchanged, or the probe breaks the server it is measuring.
  it("forwards the arguments and the receiver to the original", () => {
    const seen: unknown[] = [];
    const module = {
      name: "host",
      createServer(this: { name: string }, ...args: never[]): Server {
        seen.push(this.name, ...args);
        return fakeServer();
      },
    };
    countServedRequests(module);

    const handler = (): void => {};
    (module.createServer as (...args: unknown[]) => Server)({ keepAlive: true }, handler);

    expect(seen).toEqual(["host", { keepAlive: true }, handler]);
  });

  // Zeroing the counter is the bootstrap's job, so a module that hands out a
  // server nobody requests from must leave it untouched rather than claim zero.
  it("leaves other events alone", () => {
    const module = { createServer: (): Server => fakeServer() };
    countServedRequests(module);

    module.createServer().emit("connection");

    expect(requestProbe.__nextLeakServedRequests).toBeUndefined();
  });
});
