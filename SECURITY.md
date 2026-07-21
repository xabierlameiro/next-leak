# Security Policy

next-leak runs your app locally and never sends data anywhere: no telemetry,
no network calls beyond the load it generates against 127.0.0.1.

Heap snapshots can contain values from your application's memory (tokens,
user data present in the process at capture time). Treat `.next-leak/`
output directories as sensitive and do not attach raw snapshots to public
issues — `run.json` is enough.

## Supply chain

What an installed copy of next-leak can and cannot do is deliberately
narrow, and most of it is verifiable from the outside:

- **Two runtime dependencies** (`semver`, `zod`). Everything else ships
  pre-bundled in `dist/` — see below for why.
- **The bundle exists to keep Chrome off your machine.** next-leak uses
  memlab's heap-snapshot parser. Installing the memlab family normally
  drags in puppeteer and xvfb — a full headless-browser download this tool
  never uses. Instead, the parser is bundled at build time and `puppeteer`,
  `puppeteer-core` and `xvfb` are aliased to a stub
  (`src/stubs/browser-stub.cjs`) that throws loudly if anything ever
  reaches it: the published package cannot launch or download a browser,
  by construction.
- **autocannon is bundled for a different reason**: its transitive tree
  carries a uuid advisory with no upstream fix. Our build patches it via a
  pnpm override, and overrides do not propagate to consumers — bundling
  ships the patched tree.
- **Security scanners will flag this package, and the flags are expected**:
  it takes heap snapshots, forces GC through V8 debug APIs, injects
  instrumentation into the measured app via `--import`, and spawns child
  processes. That is the product's function, not a payload. The embedded
  URLs scanners find are `127.0.0.1` control endpoints and github.com
  links in generated issue drafts.
- **Verify instead of trusting**: `dist/` is reproducible from source with
  `pnpm build`, and `pnpm pack:smoke` installs the real tarball in
  isolation and measures a fixture app — the gate every release must pass.

## Reporting

To report a vulnerability, email xabier.lameiro@gmail.com. You will get a
response within 72 hours.
