import { describe, expect, it } from "vitest";
import { stoppedForSecurityUpgrade } from "./security-stop.js";

describe("stoppedForSecurityUpgrade", () => {
  it("recognises the build's error", () => {
    expect(stoppedForSecurityUpgrade("Error [SecurityFatalError]: Your version of Next.js is affected")).toBe(true);
  });

  it("recognises the dev server's message, which carries no error name", () => {
    // vercel/next.js#99983 reproduction on 16.4.0 under next dev, 2026-11-25.
    expect(
      stoppedForSecurityUpgrade(
        "**We strongly recommend you upgrade Next.js.**\nThis command stopped to show the upgrade recommendation. Retry the same command"
      )
    ).toBe(true);
  });

  it("ignores any other failure", () => {
    expect(stoppedForSecurityUpgrade("Error: listen EADDRINUSE: address already in use")).toBe(false);
  });
});
