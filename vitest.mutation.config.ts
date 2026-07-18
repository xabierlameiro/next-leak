import { defineConfig } from "vitest/config";

// Mutation testing runs the suite once per mutant: only fast, pure-logic
// tests belong here. Integration suites (real processes, real snapshots)
// are excluded — they are covered by the normal `pnpm test` run.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // heap-diff.test.ts belongs here despite the name: it drives the module
    // with in-memory doubles, not real snapshots, so it is as fast and as
    // mutation-worthy as any other pure-logic suite. Excluding it once left
    // the whole attribution path unjudged at a reported 100% line coverage.
    exclude: ["src/e2e.test.ts", "src/launcher.test.ts", "src/cli-interrupt.test.ts"],
  },
});
