# next-leak

> Find out whether your Next.js app actually leaks memory — how much, on which route, and whose fault it is.

Your server's memory climbs and the container gets OOM-killed. Almost every report of this ends the same way: *"please provide heap snapshots taken after forced GC"* — which almost nobody produces correctly. `next-leak` runs that controlled measurement for you and answers with evidence a maintainer would accept.

Three possible answers, all valuable:

1. **You don't have a leak** — the spike is transient and drains during idle (the most common case).
2. **The leak is in your code (or a dependency)** — named down to the source file when possible.
3. **It looks like framework internals** — with a ready-to-file issue draft.

## Quickstart

```bash
# 1. Your app must build with standalone output — in next.config:
#      output: "standalone"
next build

# 2. Measure it
npx next-leak .
```

For each discovered route, in a fresh process, it runs the validated ritual:

```
warm-up → forced GC → baseline snapshot → [load → idle → GC → sample] ×3 → snapshot
```

The verdict comes from the **shape of the post-GC curve**: retained heap that keeps growing every cycle is a leak; growth that flattens is warm-up. Absolute sizes are noise; shapes are robust.

## Options

| Flag | Default | What it does |
|---|---|---|
| `--routes <list>` | all | Only measure these routes (comma-separated templates or prefixes) |
| `--cycles <n>` | 3 | Load cycles per route (min 3) |
| `--requests <n>` | 5000 | Requests per cycle |
| `--connections <n>` | 100 | Concurrent connections |
| `--idle <seconds>` | 30 | **Maximum** wait before each sample; the run continues as soon as the heap settles |
| `--quick` | off | Fast preset (2000 requests × 4 cycles, 8s idle) — the exact profile the real-app validation ran with. Explicit flags override it |
| `--diff-all` | off | Diff snapshots for stable routes too |
| `--output <dir>` | `<app>/.next-leak` | Where runs are written |

Dynamic routes need sample params in `next-leak.config.json` in your app dir:

```json
{
  "params": { "lang": "en" },
  "routes": { "/products/[id]": { "id": "42" } },
  "headers": { "accept-encoding": "gzip, br", "cookie": "session=..." }
}
```

- **`headers`** are sent with every request. Real traffic is not header-less:
  compression, sessions and auth change which code paths run, and some leaks
  only live on those paths.
- **`{n}` inside a param value** makes every request use a *unique* URL
  (`{ "id": "item-{n}" }` → `/logs/item-1`, `/logs/item-2`, …). Leaks keyed by
  URL — route caches, LRUs, bot traffic with varied tails — are invisible
  without it.
- **`query`** appends a query string per route template
  (`{ "/api/payload/[slug]": "weightKb=2048" }`).
- **`abandonAfterMs`** makes clients hang up before the response arrives, the
  way closed tabs, load-balancer timeouts and bots do. Some leaks only exist
  on that path (`ServerResponse` retained after an early disconnect). Requests
  abandoned on purpose are not counted as failures.

`run.json` records what every load phase actually did — requests sent,
2xx, abandoned — so a run can be audited instead of trusted.

Before measuring, the CLI prints a duration estimate — a 60-route app under defaults is **hours**; narrow with `--routes` for iteration.

## Reading the verdicts

- **`stable`** — done, stop hunting. The report proves it. If the heap is flat
  but RSS keeps climbing, the report says so explicitly: that is an allocator,
  external-buffer or fragmentation problem, not a JS-heap leak.
- **`leak`** — the report names the culprit when attribution resolves: your file (`culprit: src/app/x/page.tsx (your code)`), a dependency (package name), or framework internals. An `ISSUE-<route>.md` draft is generated; if the leak is app-owned, the draft tells you **not** to file it upstream.
- **`inconclusive`** — sustained sub-threshold growth: measure longer. The CLI prints the exact re-run command (`--routes <those> --cycles 6`).
- **`failed`** — the route errored under load (auth redirects, POST-only endpoints). >1% non-2xx aborts measurement instead of measuring garbage. That's by design.

## The tool grades its own measurement

A leak detector is an instrument, and a miscalibrated instrument doesn't fail
loudly — it reports confident, wrong numbers. So every run is audited against
its own evidence, and anything that undermines a verdict is printed next to it:

```
✖ /api/items  leak  (+3.10 MB/1000 req)  heap 28.4 MB → 41.9 MB → …
    ⚠ low confidence: cycle 2 landed 4310 of 5000 requests (86.2%) — the route
      saw less traffic than reported
```

What gets checked: whether the heap actually held still before each sample,
whether the requests you asked for really landed, whether an early-disconnect
run disconnected anything, whether one cycle dominates the average, and
whether the growth barely clears the noise floor.

When the run didn't observe what a `leak` verdict requires — the heap never
settled, or an abandonment run abandoned nothing — the verdict is **withdrawn**
and reported as `inconclusive`, with what was measured still on the record. A
withdrawn verdict produces no `ISSUE-*.md` draft: only a verdict the evidence
supports is worth pasting into someone else's tracker. Caveats that don't
overturn a verdict still travel with the draft, under *Measurement caveats*.

Stable verdicts are never withdrawn. Quietly missing a leak costs you less
than a false accusation, and the warnings are on the report either way.

## Every run leaves evidence

```
.next-leak/<timestamp>/
├── report.html        # heap curves per route — self-contained, opens offline
├── ISSUE-<route>.md   # issue draft per leaking route (Next.js bug-template shape)
├── run.json           # everything, machine-readable: environment, per-phase
│                     # timings, heap AND RSS samples per cycle, what each
│                     # load phase actually did, and the confidence audit
└── <nn>-<route>/      # raw baseline/after .heapsnapshot per route
```

Snapshots are the ground truth: load them in Chrome DevTools (Memory → Load → Comparison) and check every claim yourself. Runs accumulate — each keeps its snapshots (tens of MB per route); delete old timestamp folders when done.

## Scope and limits (read before filing issues)

- **Supported:** App Router · `output: "standalone"` · Node ≥ 22 · Linux/macOS. Pages Router, non-standalone, and Windows are rejected with a clear message.
- **Architectures:** verified on **arm64 and x64** (linux/amd64 in Docker) — same app, same parameters, same verdicts.
- **Attribution** (naming the file) needs a Turbopack build with server sourcemaps — the Next 15+ default. On webpack builds the registry is empty by design and findings degrade to `unattributed` with raw retainer chains; measurement itself does not depend on it. Note that `output: "standalone"` + `--webpack` produced a bundle that could not start at all on `16.3.0-canary.90` (missing `@swc/helpers`), independently of this tool.
- Empirically validated on Next **15.5.4, 16.0.x, 16.1.5, 16.2.x and 16.3-canary** (incl. Sentry, OpenTelemetry, PPR and i18n apps), against real reproductions from open issues. The contracts it relies on are stable since Next 13–14, but older versions are untested.
- Borderline routes can flip between `stable`/`leak` across runs — more cycles resolves this.
- The measured app runs with its real environment: routes that call external services will call them under load. Scope with `--routes` and moderate `--requests` accordingly.

## Development

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build
pnpm pack:smoke      # release gate: installs the real tarball and measures the fixture app
pnpm test:mutation   # Stryker — slow; run before releases, weekly in CI
```

CI runs typecheck, tests, build, `pnpm audit --prod` and the pack smoke on
Node 22 and 24; mutation testing runs weekly and uploads its report.

Spec-driven with [OpenSpec](https://github.com/Fission-AI/OpenSpec): current behavior in `openspec/specs/`, history in `openspec/changes/archive/`.

## License

MIT
