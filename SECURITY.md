# Security Policy

next-leak runs your app locally and never sends data anywhere: no telemetry,
no network calls beyond the load it generates against 127.0.0.1.

Heap snapshots can contain values from your application's memory (tokens,
user data present in the process at capture time). Treat `.next-leak/`
output directories as sensitive and do not attach raw snapshots to public
issues — `run.json` is enough.

## The control channel

While a route is measured, next-leak loads a small HTTP server into your
app's process through `--import`. It is how the run forces collection, reads
memory and asks for heap snapshots.

- **It listens on `127.0.0.1`**, on a port the operating system picks, and it
  lives as long as the measured process does.
- **Every request must carry a token.** next-leak generates one for each
  process it launches (32 random bytes), hands it over in the environment as
  `NEXT_LEAK_TOKEN`, and never writes it to disk. A request without it gets a
  403 before anything runs.
- **Loopback alone is not enough**, which is why the token exists. It keeps
  other machines out, but any local process can reach the port, and so can a
  web page open in a browser on the same machine.
- **What the token does not cover**: the measured app and anything it starts
  can read it, and on most systems so can another process running as the same
  user. It separates the run from other users and from the browser, not from
  code already running as you.
- **What the channel can do**: force a collection, report memory figures
  along with the process's `argv` and working directory, and write a heap
  snapshot into the run's own directory. It cannot read files, run code, write
  anywhere else or send a snapshot's content back.
- `next-leak build` does not use it. It reads the process table and signals
  the worker instead.

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
- **The stub is tested, not asserted.** `scripts/check-bundle.mjs` runs on
  every build and again against the *installed* tarball in `pack:smoke`: it
  fails if the stub is missing from the bundle (the alias stopped matching),
  if a bare `require("puppeteer")` survived, if strings unique to real
  browser tooling appear, or if the bundle grows past a size ceiling. A
  memlab upgrade that reintroduces Chrome breaks the build instead of
  shipping.
- **Licences travel with the bundle**: [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)
  reproduces the licence of every package inlined into `dist/` — 88 of them,
  since the transitive trees come along too. It is generated from the build's
  own metafile, and the build fails if a bundled package's terms cannot be
  determined.
- **Verify instead of trusting**: `dist/` is reproducible from source with
  `pnpm build`, and `pnpm pack:smoke` installs the real tarball in
  isolation and measures a fixture app — the gate every release must pass.

## Reporting

To report a vulnerability, email xabier.lameiro@gmail.com. You will get a
response within 72 hours.
