import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/**
 * `SECURITY.md` claims the published package "cannot launch or download a
 * browser, by construction". That rests on this stub being what memlab reaches
 * for, and on it refusing everything except the handful of lookups memlab does
 * at module init. The stub had no test at all — the claim was backed by three
 * alias lines in the build config and nothing else.
 *
 * `scripts/check-bundle.mjs` covers the other half: that the alias actually
 * applied and no real browser tooling survived into `dist/`.
 */
describe("browser stub", () => {
  const stub = require("./browser-stub.cjs") as any;

  it("satisfies the data-only lookups memlab performs at module init", () => {
    // If these threw, importing the heap-analysis code would fail outright —
    // which is why they are the only exceptions.
    expect(stub.KnownDevices).toEqual({});
    expect(stub.devices).toEqual({});
    expect(stub.__esModule).toBe(true);
    expect(stub.default).toBe(stub);
  });

  it("refuses every other property, loudly and by name", () => {
    expect(() => stub.launch).toThrow(/browser tooling is not available/);
    expect(() => stub.launch).toThrow(/attempted to use "launch"/);
    expect(() => stub.connect).toThrow(/attempted to use "connect"/);
    // The message has to say this is a bug in next-leak, not in the user's
    // app: reaching here means heap parsing took a path it never should.
    expect(() => stub.executablePath).toThrow(/this is a bug, please report it/);
  });

  it("refuses being called or constructed", () => {
    expect(() => stub()).toThrow(/attempted to use "call"/);
    expect(() => new stub()).toThrow(/attempted to use "new"/);
  });
});
