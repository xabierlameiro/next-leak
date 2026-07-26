# next-leak

[![npm](https://img.shields.io/npm/v/next-leak.svg)](https://www.npmjs.com/package/next-leak)
[![CI](https://github.com/xabierlameiro/next-leak/actions/workflows/ci.yml/badge.svg)](https://github.com/xabierlameiro/next-leak/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/next-leak.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/next-leak.svg)](./LICENSE)

> Find out whether your Next.js app actually leaks memory — how much, on which route, and whose fault it is.

<img src="https://raw.githubusercontent.com/xabierlameiro/next-leak/main/docs/demo.svg" alt="next-leak finding a real Next.js memory leak (43-second run, idle time compressed)" width="720">

```
$ npx next-leak . --quick

  ✖ /api/heap  leak  (+4.70 MB/1000 req)
    heap 28.7 → 40.3 → 59.0 → 75.8 → 75.9 → 101.2 → 101.2 → 139.0 → 139.0 MB
      ↳ grown [object] Array 112.5 MB — TimeoutsManager#object[.resources]
        <- system / Context#object[.timeoutsManager] <- destroy#closure[.context]
        <- ResourceManager#object[.properties] <- IntervalsManager#object[.map]

  ✔ /            stable  (+0.02 MB/1000 req)  heap 40.9 → 35.3 → 35.3 → 35.4 MB
  ✔ /convenio    stable  (+0.02 MB/1000 req)  heap 36.3 → 37.0 → 37.1 → 37.1 MB
```

That first line is a real run against the reproduction for
[vercel/next.js#95094](https://github.com/vercel/next.js/issues/95094), an open
Next.js issue: the sandbox's `TimeoutsManager` never releases timeout ids from
middleware. next-leak found the growth, the retaining object and the chain that
holds it — without being told what to look for.

**Verified against real, open Next.js issues**, not synthetic fixtures:

| Issue | What it is | Result |
|---|---|---|
| [#95094](https://github.com/vercel/next.js/issues/95094) | Middleware `setTimeout` ids retained by the sandbox | **Reproduced** · mechanism named · 112 MB retained |
| [#94890](https://github.com/vercel/next.js/issues/94890) | Router LRU cache doesn't count its keys | **Reproduced** · 26.7 → 71.9 MB |
| [#84884](https://github.com/vercel/next.js/issues/84884) | axios + `AbortSignal` in middleware | **Reproduced** · 32.8 → 369.9 MB |
| [#94919](https://github.com/vercel/next.js/issues/94919) | RSC tree retained on client aborts | **Reproduced** · 39 → 139 MB · [with a caveat](#scope-and-limits-read-before-filing-issues) |

The full causal chain, measured on that same issue: leak found (28.7 -> 138.9 MB
across 8 cycles), the workaround from the thread applied (`clearTimeout(id)`
inside the callback), same app re-measured with identical parameters:
**27.8 -> 25.6 MB, flat**. That is what a diagnostic tool should prove - not
that installing it saves memory, but that what it points at is the real cause.

Across ~25 healthy routes on production applications (PPR, MDX, Auth.js,
Sentry, i18n), it reported **zero false positives**.

Your self-hosted Next.js server's memory climbs until Node gives up:

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

Under Docker or Kubernetes you may not even get that: the process is `OOMKilled`,
the container exits with **code 137**, and the restart wipes the evidence before
you can look at it. Almost every report of this ends the same way — *"please
provide heap snapshots taken after forced GC"* — which almost nobody produces
correctly. `next-leak` runs that controlled measurement for you and answers with
evidence a maintainer would accept.

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
warm-up → forced GC → baseline snapshot → [load → idle → GC → sample] ×4 → snapshot
```

The verdict comes from the **shape of the post-GC curve**: retained heap that
keeps growing every cycle is a leak; growth that flattens is warm-up. Where the
heap sits is noise — 40 MB and 400 MB say nothing on their own — so only the
shape is judged. The one absolute number involved is the gate a cycle's growth
must clear to count, and above 5000 requests per cycle it scales with the
traffic that cycle served — so in that range changing `--requests` changes how
long the run takes and not what it decides. Below 5000 the gate stops shrinking
and sits on the instrument's noise floor instead, so less traffic really does
buy a less sensitive run: that is the trade `--quick` makes at 2000 requests.
Every report prints the gate it used.

## Options

| Flag | Default | What it does |
|---|---|---|
| `--routes <list>` | all | Only measure these routes (comma-separated templates or prefixes) |
| `--cycles <n>` | 4 | Load cycles per route (min 3). The first is dropped as warm-up, so the verdict sees `n − 1` deltas — at 3 it sees two |
| `--requests <n>` | 5000 | Requests per cycle. Raises sensitivity as well as duration: the growth gate scales with it, down to a noise floor around 5000 |
| `--connections <n>` | 100 | Concurrent connections |
| `--idle <seconds>` | 30 | **Maximum** wait before each sample; the run continues as soon as the heap settles |
| `--max-old-space <mb>` | 512 | Heap cap of each measured process. Raise it for apps whose legitimate working set is larger, or they die under measurement |
| `--quick` | off | Fast preset (2000 requests × 4 cycles, 8s idle) — the exact profile the real-app validation ran with. Same cycle count as the default; what it trades away is traffic per cycle, so it sits on the noise floor and is less sensitive to slow leaks. Explicit flags override it |
| `--no-resolve` | off | Skip the second pass on inconclusive routes |
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
- **`abandonAfterMs`** makes clients hang up mid-response, the way closed tabs,
  load-balancer timeouts and bots do. Some leaks only exist on that path
  (`ServerResponse` retained after an early disconnect; the RSC tee branch in
  [#94919](https://github.com/vercel/next.js/issues/94919)). The clock starts
  at the **first byte of the response**, not at the request — under load a
  request-relative window cuts before the stream begins and tests a different
  path. Small values are the point: `4` means "read the first chunk, then
  vanish". Requests abandoned on purpose are not counted as failures.

`run.json` records what every load phase actually did — requests sent,
2xx, abandoned — so a run can be audited instead of trusted.

Before measuring, the CLI prints a duration estimate — a 60-route app under defaults is **hours**; narrow with `--routes` for iteration.

## What it tells apart

"Memory leak" is one name for six different situations. The verdict machinery
separates them, because each one has a different fix:

| Looks like a leak | What next-leak reports | How it knows |
|---|---|---|
| One-time warm-up growth (JIT, lazy caches) | `stable` | The first cycle is excluded from the verdict; warm-up flattens, leaks keep climbing |
| A route that is expensive, not leaky | `failed` under load it cannot sustain, flat once concurrency fits | Real leaks survive forced GC at any concurrency; saturation disappears when load drops |
| Growth that pauses and resumes (stepwise) | `leak` | A healthy route gives back 20-30% of its growth; a stepwise leak gives back nothing |
| Native/buffer memory with a flat JS heap | `leak (external)` or an explicit RSS note | Heap, `external` and RSS are sampled and judged separately |
| A leak in your code vs a dependency vs Next itself | `culprit: src/app/x/page.tsx (your code)` — or the package, or framework internals | Retainer chains mapped through the build's source maps |
| A run whose own evidence is weak | `low confidence` warnings, or the verdict is withdrawn | Every run audits itself: did the load land, did the heap settle, does one cycle carry the average, did the heap run into its own ceiling |

## Reading the verdicts

- **`stable`** — no growth this run could detect: across the cycles it ran, the
  post-GC curve never cleared the growth gate printed at the foot of the
  report. That is not proof of absence, and the wording matters — the verdict
  is deliberately biased toward missing a leak rather than inventing one (a
  single flat or falling cycle is enough to call a route stable), so a leak
  that oscillates while it climbs can land here. To press harder, raise
  `--cycles` — every extra cycle is another delta the verdict gets to see.
  Raising `--requests` only helps from below 5000: above that the gate scales
  with the traffic, so the longer run decides the same thing. If the heap is
  flat but RSS keeps climbing, the report says so explicitly: that is an
  allocator, external-buffer or fragmentation problem, not a JS-heap leak.
- **`leak`** — the report names the culprit when attribution resolves: your file (`culprit: src/app/x/page.tsx (your code)`), a dependency (package name), or framework internals. An `ISSUE-<route>.md` draft is generated; if the leak is app-owned, the draft tells you **not** to file it upstream.
- **`inconclusive`** — the evidence does not decide. The run does not stop there: any inconclusive route is **measured again automatically**, with twice the cycles, and the second pass is what you see (`resolved at 8 cycles` next to the verdict). On the reproduction for [#95094](https://github.com/vercel/next.js/issues/95094), `--quick` alone reports `inconclusive` on three deltas and then comes back with the leak. `--no-resolve` turns the second pass off; when even that is undecided, the re-run command is still printed.
- **`failed`** — the route errored under load (auth redirects, POST-only endpoints). >1% non-2xx aborts measurement instead of measuring garbage. That's by design.

## Peak pressure: `stable` is not the same as safe

Every verdict above is about what a route **retains** after idle and a forced
GC. That is the right question for a leak and the wrong one for an
`OOMKilled`: a process can climb to gigabytes under load, hand it all back
when the load stops, and still be killed at its peak. So each load cycle is
also sampled *without* collecting, and the highest value is reported next to
the verdict:

```
✔ /[slug]  stable  (-164.08 MB/1000 req)  heap 261.9 MB → 265.7 MB → 35.4 MB → 36.0 MB
    ▲ peak pressure: peaked at 3145.7 MB rss under load while retaining 36.0 MB —
      a container sized on what it retains dies on what it reaches
```

That is a real measurement of the reproduction in
[vercel/next.js#92287](https://github.com/vercel/next.js/issues/92287): no
retention, and 3 GB reached. The note fires when the peak heap comes within
75% of `--max-old-space`, or when peak RSS is at least 8× the retained heap
and above 512 MB. It never changes the verdict — retention and peak are
different questions, and only one of them is a leak. A peak is the highest
value *sampled* (every 250 ms), so it is a lower bound.

If the measured process dies at the limit instead of merely approaching it,
the route fails saying exactly that, with the limit in force and how to raise
it.

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
run disconnected anything, whether one cycle dominates the average, whether
the growth barely clears the noise floor, and whether the heap came close
enough to its own cap that the curve was clipped by the ceiling rather than by
the app.

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

## Why not just use…

| | What it gives you | Where it stops |
|---|---|---|
| **Chrome DevTools** | The ground truth: two snapshots and a comparison view | You reproduce the load, force the GC, pick the moments and read the retainers yourself. Doing it *correctly* is the hard part |
| **[memlab](https://github.com/facebook/memlab)** | A superb heap-analysis engine — next-leak **uses it** to parse snapshots | It is built around browser scenarios you script. It does not drive HTTP load against your routes, and it knows nothing about Next.js route manifests or your bundle's source maps |
| **[clinic.js](https://github.com/clinicjs/node-clinic)** | Broad Node performance profiling | [Its own README](https://github.com/clinicjs/node-clinic#readme) states it is no longer actively maintained |
| **`--inspect` + manual snapshots** | Full control | Same as DevTools, plus you must keep the process, the load and the snapshots in sync by hand |

What next-leak adds is not analysis — it is **the controlled experiment around
it**: a fresh process per route, warm-up before the baseline, forced GC and an
adaptive idle before every sample, an audit of whether the load it claims to
have sent actually landed, and a verdict from the curve's shape rather than
absolute sizes. Then it maps the retaining objects back to *your* source files
through the build's source maps.

## Scope and limits (read before filing issues)

- **Supported:** App Router · `output: "standalone"` · Node ≥ 22 · Linux/macOS. Pages Router, non-standalone, and Windows are rejected with a clear message.
- **Architectures:** verified on **arm64 and x64** (linux/amd64 in Docker) — same app, same parameters, same verdicts.
- **Attribution** (naming the file) needs a Turbopack build with server sourcemaps — the Next 15+ default. On webpack builds the registry is empty by design and findings degrade to `unattributed` with raw retainer chains; measurement itself does not depend on it. Note that `output: "standalone"` + `--webpack` produced a bundle that could not start at all on `16.3.0-canary.90` (missing `@swc/helpers`), independently of this tool.
- Empirically validated on Next **15.5.4, 16.0.x, 16.1.5, 16.2.x and 16.3-canary** (incl. Sentry, OpenTelemetry, PPR and i18n apps), against real reproductions from open issues. The contracts it relies on are stable since Next 13–14, but older versions are untested.
- **Each measured process runs under a 512 MB heap cap** by default, so a leak
  reaches a ceiling in minutes instead of the hours a production container
  takes. An app whose legitimate working set is larger needs
  `--max-old-space`, or every route dies as an OOM that is not the app's
  fault. When a run's heap gets close to the cap, the report says so.
- Borderline routes can flip between `stable`/`leak` across runs — more cycles resolves this.
- The [#94919](https://github.com/vercel/next.js/issues/94919) reproduction ships
  a **custom Express server and deliberately no standalone output**, which this
  tool cannot measure as published. The figure above comes from the same app
  built with `output: "standalone"` — the leak is there too, but that is Next's
  server under test, not the reporter's middleware chain. Instrumenting their
  own server by hand (same `--import` bootstrap, no CLI) showed the same shape:
  post-GC heap 43 → 56 MB and arrayBuffers 0.2 → 10.7 MB over four cycles.
- The **peak-pressure** thresholds are calibrated against one reproduction measured in three regimes plus the bundled fixture, not against the ~40-route validation set the verdicts were tuned on. A peak note never changes a verdict, so the cost of a false one is noise, not a false accusation — but treat the exact thresholds as young.
- The measured app runs with its real environment: routes that call external services will call them under load. Scope with `--routes` and moderate `--requests` accordingly.

## Development

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build
pnpm pack:smoke      # release gate: installs the real tarball and measures the fixture app
pnpm test:mutation   # Stryker — slow; run before releases, weekly in CI
```

`pnpm build` also regenerates [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)
from the build's metafile and runs `scripts/check-bundle.mjs`, which fails the
build if browser tooling ever gets back into `dist/`. Commit the regenerated
notices when a dependency changes.

CI runs typecheck, tests, build, `pnpm audit --prod` and the pack smoke on
Node 22 and 24; mutation testing runs weekly and uploads its report.

## License

MIT
