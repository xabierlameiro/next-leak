# Contributing

Thanks for your interest in next-leak.

## Ground rules

- Open an issue before large changes — measurement semantics are calibrated
  against real applications, and a well-meaning tweak to a threshold can
  silently change verdicts.
- Every PR must pass CI (typecheck + tests on Node 22/24, macOS + Linux).
- Conventional Commits, header ≤ 100 chars. commitlint enforces this locally.
- New behavior needs tests. Verdict-related changes also need a mutation run
  (`npm run test:mutation`) — line coverage alone has lied to us before.

## Development

```bash
pnpm install
pnpm test          # unit + e2e (builds the fixture app once)
pnpm typecheck
pnpm build
pnpm pack:smoke    # verifies the published tarball actually works installed
```

## What makes a good bug report

Attach the `run.json` from your `.next-leak/<timestamp>/` directory. It
contains the full audit trail (per-phase load outcomes, settle results,
confidence warnings) and usually answers the question before anyone asks it.
