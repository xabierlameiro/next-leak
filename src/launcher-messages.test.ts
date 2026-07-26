import { describe, expect, it } from "vitest";
import { explainRuntimeFailure, explainStartupFailure } from "./launcher.js";

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
