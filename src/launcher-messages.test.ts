import { describe, expect, it } from "vitest";
import {
  appNeverListened,
  explainRuntimeFailure,
  explainStartupFailure,
  meansNotListening,
  probeFailure,
} from "./launcher.js";

// Pure message functions, split from launcher.test.ts (which boots real
// processes and is excluded from mutation runs) so mutation can judge the
// half of the launcher that is judgeable without spawning anything.
// Hit while validating webpack builds: a standalone bundle shipped without
// @swc/helpers. The tool was the messenger; the message was a stack dump.
describe("explainStartupFailure", () => {
  it("turns a missing dependency into an actionable sentence", () => {
    const message = explainStartupFailure(
      "Error: Cannot find module '@swc/helpers/_/_interop_require_default'\n  at ..."
    );
    expect(message).toContain("@swc/helpers/_/_interop_require_default");
    expect(message).toContain("build problem, not a measurement one");
    // Every clause of this sentence is the remedy someone follows at 2am.
    expect(message).toContain("fails the same way on its own");
    expect(message).toContain("copy the missing package into");
    expect(message).not.toContain("at ...");
  });

  it("names a port clash plainly", () => {
    expect(explainStartupFailure("listen EADDRINUSE 127.0.0.1:3000")).toContain("port was taken");
  });

  it("falls back to the raw stderr when the cause is unknown", () => {
    expect(explainStartupFailure("something odd happened")).toContain("something odd happened");
  });
});

// A process killed by the heap limit used to surface as "fetch failed" three
// calls later, which reads like a bug in the tool instead of the finding it is.
describe("explainRuntimeFailure", () => {
  const V8_FATAL = [
    "<--- Last few GCs --->",
    "[3314:0xde692d0] 178177 ms: Mark-Compact 2617.4 (2653.9) -> 2214.5 (2274.8) MB",
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
  ].join("\n");

  it("names heap exhaustion, the limit in force, and the way out", () => {
    const message = explainRuntimeFailure(V8_FATAL, 512);
    expect(message).toContain("ran out of heap");
    expect(message).toContain("--max-old-space-size=512");
    expect(message).toContain("does not fit in 512 MB under this load");
    expect(message).toContain("--max-old-space <mb>");
    expect(message).toContain("--requests/--connections");
  });

  it("recognises the ineffective mark-compact wording too", () => {
    const message = explainRuntimeFailure(
      "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed",
      4096
    );
    expect(message).toContain("4096 MB");
  });

  it("falls back to the startup explanation for any other death", () => {
    expect(explainRuntimeFailure("Error: Cannot find module 'x'", 512)).toContain(
      "build problem"
    );
  });

  it("recognises a REAL-sized fatal dump, where the FATAL line is nowhere near the end", () => {
    // A genuine V8 OOM dump: GC trace, the one load-bearing line, then ~75
    // native frames pushing it thousands of characters from the tail. The
    // measured process on the vercel/next.js#89091 repro died exactly like
    // this and was reported as a generic exit, because only a 2000-char tail
    // was kept.
    const frames = Array.from(
      { length: 75 },
      (_, index) =>
        `${index + 1}: 0x108e3a4${String(index).padStart(2, "0")} node::SomeVeryLongNativeFrameName::WithTemplates<v8::internal::DirectHandle<v8::internal::Object>>(v8::FunctionCallbackInfo<v8::Value> const&) [/opt/homebrew/lib/libnode.141.dylib]`
    ).join("\n");
    const dump =
      "<--- Last few GCs --->\n" +
      "[48563:0xb65c00000] 26941 ms: Scavenge 496.6 (505.3) -> 493.7 (506.1) MB\n" +
      "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\n" +
      "----- Native stack trace -----\n" +
      frames;
    expect(dump.length).toBeGreaterThan(8000);
    // The window handed to the explainer must still contain the FATAL line.
    const window = `${dump.slice(0, 4096)}\n[...]\n${dump.slice(-4096)}`;
    expect(explainRuntimeFailure(window, 512)).toContain("ran out of heap");
  });
});

// The app port staying shut is the one failure the launcher used to describe
// by naming the port and nothing else — while holding the process's own
// explanation in a buffer it only printed if the process had died (#71).
describe("appNeverListened", () => {
  it("hands over what the process wrote while starting", () => {
    const message = appNeverListened("127.0.0.1", 44203, 60_000, "Error: DATABASE_URL is not set\n");
    expect(message).toContain("127.0.0.1:44203");
    expect(message).toContain("never accepted a connection within 60s");
    expect(message).toContain("DATABASE_URL is not set");
  });

  it("names the budget and the flag that moves it when the process said nothing", () => {
    const message = appNeverListened("127.0.0.1", 44203, 15_000, "   \n");
    expect(message).toContain("never accepted a connection within 15s");
    expect(message).toContain("wrote nothing to stderr");
    expect(message).toContain("--ready-timeout");
  });
});

// The probe used to collapse every failure into "not listening yet". Only one
// of these is that; the rest are answers from a port that was open all along.
describe("probeFailure", () => {
  it("digs the code out of the TypeError fetch rejects with", () => {
    const failed = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:44203"), {
        code: "ECONNREFUSED",
      }),
    });
    expect(probeFailure(failed)).toBe("ECONNREFUSED");
  });

  it("falls back to the inner message when there is no code", () => {
    const failed = new TypeError("fetch failed", {
      cause: new Error("redirect count exceeded"),
    });
    expect(probeFailure(failed)).toBe("redirect count exceeded");
  });
});

describe("meansNotListening", () => {
  it("is true only for a refused connection", () => {
    expect(meansNotListening("ECONNREFUSED")).toBe(true);
    expect(meansNotListening("EHOSTUNREACH")).toBe(true);
  });

  it("is false for everything that happens after the handshake", () => {
    // Measured on Node 24: a socket destroyed mid-request, a reset, and a
    // redirect loop all reach the probe as failures, and all three prove the
    // port was open.
    expect(meansNotListening("UND_ERR_SOCKET")).toBe(false);
    expect(meansNotListening("ECONNRESET")).toBe(false);
    expect(meansNotListening("redirect count exceeded")).toBe(false);
  });
});

describe("appNeverListened, on a port that really was closed", () => {
  it("names the refusal it kept seeing", () => {
    const message = appNeverListened("127.0.0.1", 44203, 60_000, "", "ECONNREFUSED");
    expect(message).toContain("never accepted a connection (ECONNREFUSED) within 60s");
  });
});
