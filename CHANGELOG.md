# Changelog

## [0.11.0](https://github.com/xabierlameiro/next-leak/compare/v0.10.1...v0.11.0) (2026-09-03)


### Features

* **cli:** add --repeat to judge a route across repeated runs ([aea8c42](https://github.com/xabierlameiro/next-leak/commit/aea8c42e698678150ab4c89fbc1604c2d6c3f549))
* **trend:** stop calling a saturated curve a leak, and repeat before judging ([c72b7c5](https://github.com/xabierlameiro/next-leak/commit/c72b7c577b26fc85dc600eb800c40c51af85517d))


### Bug Fixes

* **trend:** reach saturation when deceleration drops the tail below the gate ([e12fa48](https://github.com/xabierlameiro/next-leak/commit/e12fa48a4caf15f810aaeab3588578e5ce80b613))

## [0.10.1](https://github.com/xabierlameiro/next-leak/compare/v0.10.0...v0.10.1) (2026-09-01)


### Bug Fixes

* **control-client:** judge a snapshot wait by bytes on disk, not the clock ([5758aa6](https://github.com/xabierlameiro/next-leak/commit/5758aa6d0746c2da69c10886d55775ec7954c1d3))
* judge a snapshot wait by bytes on disk, not the clock ([b652944](https://github.com/xabierlameiro/next-leak/commit/b652944ef2d33b1ea0e896470292e247e11ac9d7))

## [0.10.0](https://github.com/xabierlameiro/next-leak/compare/v0.9.0...v0.10.0) (2026-08-28)


### Features

* **self-check:** prove the harness works before trusting a stable verdict ([91f4068](https://github.com/xabierlameiro/next-leak/commit/91f4068562cb6fc5f8b148ec6071fa7a667694e9))
* tell a filling cache from a leak, and prove the harness works ([147678e](https://github.com/xabierlameiro/next-leak/commit/147678e5bcc64f894f45a42de74745c7372b6531))
* **trend:** tell a filling cache from a leak ([284d539](https://github.com/xabierlameiro/next-leak/commit/284d539bef22fa7cb0d2635f60b17b56ce587348))


### Bug Fixes

* **build:** point the stripped-cap warning at NODE_OPTIONS ([133d9ba](https://github.com/xabierlameiro/next-leak/commit/133d9ba75297362cd06abc4eaf3bf9a6779d1d3d))
* **heap-diff:** judge a snapshot by what actually gets parsed ([825641b](https://github.com/xabierlameiro/next-leak/commit/825641ba8fc25c04beb2ff7c0d599bf41933f8ba))
* **heap-diff:** keep scanning past the first chunk to find edges ([319afda](https://github.com/xabierlameiro/next-leak/commit/319afdafa16d5b29afad895f4620ab9c9e2d03a3))

## [0.9.0](https://github.com/xabierlameiro/next-leak/compare/v0.8.0...v0.9.0) (2026-08-27)


### Features

* report what the build's own process reached ([9408302](https://github.com/xabierlameiro/next-leak/commit/94083021b00c780454d3587b734d3a172833397d))


### Bug Fixes

* never propose a sample value the build already prerendered ([18605bd](https://github.com/xabierlameiro/next-leak/commit/18605bde3ccac2b9971421021f36bc5dc02f0a1b))
* report a route that ran out of heap as a leak, not as a failed run ([15101b3](https://github.com/xabierlameiro/next-leak/commit/15101b39f0289f60f8266aa8509fcc3e9f896511))
* tell a closed param set apart from a broken route ([6c5c6c6](https://github.com/xabierlameiro/next-leak/commit/6c5c6c650240096bf21df1e99d309d4eb894f166))

## [0.8.0](https://github.com/xabierlameiro/next-leak/compare/v0.7.0...v0.8.0) (2026-08-19)


### Features

* say what a build's worker retains, not only that it retains ([7e6cd0a](https://github.com/xabierlameiro/next-leak/commit/7e6cd0a6e486cdef03a9137991df56cbe32b2c6a))

## [0.7.0](https://github.com/xabierlameiro/next-leak/compare/v0.6.0...v0.7.0) (2026-08-19)


### Features

* let a route cut its clients before the response starts ([#52](https://github.com/xabierlameiro/next-leak/issues/52)) ([76f6c97](https://github.com/xabierlameiro/next-leak/commit/76f6c97fd0842b01d8a2854c98cbabfc48df0b77))

## [0.6.0](https://github.com/xabierlameiro/next-leak/compare/v0.5.1...v0.6.0) (2026-08-18)


### Features

* a skipped route now prints the config that would measure it ([5e380b6](https://github.com/xabierlameiro/next-leak/commit/5e380b6235f7066d4ab465610513c0920c4a40b2))
* bounded key cardinality, so a run can revisit a fixed key set ([ea16c66](https://github.com/xabierlameiro/next-leak/commit/ea16c6650881e8103dd0659b91bc026b9e17fc44))
* drive ISR routes so the load reaches the render ([07402c7](https://github.com/xabierlameiro/next-leak/commit/07402c755d6d5dc8c6bad953ad57860058e4099a))
* measure the memory of a build, not just of a built server ([4a6942c](https://github.com/xabierlameiro/next-leak/commit/4a6942c5c55d2925437cdeedda6e35917de4e9b8))
* read what a process holds before collection, not only after it ([7358b83](https://github.com/xabierlameiro/next-leak/commit/7358b83adb87272ce9f1eb46aa37a5bcddd9513c))
* say how much of the app the run actually covered ([6505d0d](https://github.com/xabierlameiro/next-leak/commit/6505d0da75534dcc12c56e4c7106a082a68347bd))
* say when the baseline is carrying warm-up's memory ([2549101](https://github.com/xabierlameiro/next-leak/commit/2549101841e2e01e7279d3935e7f742e5c719d81))
* tell saturation apart from a route that is actually broken ([38d93b7](https://github.com/xabierlameiro/next-leak/commit/38d93b7acdc92692895cb86ab45990909fcc71ce))


### Bug Fixes

* key the unreclaimed note on the gap, not on a slope ([796e6ad](https://github.com/xabierlameiro/next-leak/commit/796e6ada18cb10d91a2d614cfbd5094f51a49c36))
* never lose a finished measurement to a snapshot that cannot be parsed ([9beb7bf](https://github.com/xabierlameiro/next-leak/commit/9beb7bfdd4206973be00038cce19e61da1488952))
* stop acquitting a route that oscillates while it climbs ([9ed18d2](https://github.com/xabierlameiro/next-leak/commit/9ed18d299979704bebe2a3b4c14547ff89577032))

## [0.5.1](https://github.com/xabierlameiro/next-leak/compare/v0.5.0...v0.5.1) (2026-07-26)


### Bug Fixes

* keep both ends of the measured process's stderr, not just the tail ([#44](https://github.com/xabierlameiro/next-leak/issues/44)) ([254384b](https://github.com/xabierlameiro/next-leak/commit/254384b7db242455a682870572f6d336d39b32ed))

## [0.5.0](https://github.com/xabierlameiro/next-leak/compare/v0.4.3...v0.5.0) (2026-07-26)


### ⚠ BREAKING CHANGES

* LoadPhaseOptions (exported from the package root) no longer accepts abandonAfterMs; callers get a type error instead of whole-second, pre-first-byte behaviour. The CLI and the next-leak.config.json knob are unchanged.

### Code Refactoring

* remove the legacy autocannon-timeout abandon path from the load phase ([#41](https://github.com/xabierlameiro/next-leak/issues/41)) ([77a129c](https://github.com/xabierlameiro/next-leak/commit/77a129c17808a9829da838a1211a1e0226f634c7))

## [0.4.3](https://github.com/xabierlameiro/next-leak/compare/v0.4.2...v0.4.3) (2026-07-26)


### Bug Fixes

* own the control channel's deadlines instead of inheriting undici's ([#35](https://github.com/xabierlameiro/next-leak/issues/35)) ([44e2332](https://github.com/xabierlameiro/next-leak/commit/44e2332f748b6f2f15be3d0d5cab67904734e185))

## [0.4.2](https://github.com/xabierlameiro/next-leak/compare/v0.4.1...v0.4.2) (2026-07-26)


### Bug Fixes

* keep the first pass when a re-measurement dies, and honour Ctrl+C between passes ([#33](https://github.com/xabierlameiro/next-leak/issues/33)) ([567e0d1](https://github.com/xabierlameiro/next-leak/commit/567e0d1f786847959c7655596114515015c09de4))

## [0.4.1](https://github.com/xabierlameiro/next-leak/compare/v0.4.0...v0.4.1) (2026-07-26)


### Bug Fixes

* stop calling healthy routes leaks, and answer the ones it cannot call ([#31](https://github.com/xabierlameiro/next-leak/issues/31)) ([b90f474](https://github.com/xabierlameiro/next-leak/commit/b90f474cc20c2738bfe7965bc7d897ac886de580))

## [0.4.0](https://github.com/xabierlameiro/next-leak/compare/v0.3.0...v0.4.0) (2026-07-26)


### ⚠ BREAKING CHANGES

* the same `abandonAfterMs` value produces different traffic, so runs recorded before this change are not comparable with runs after it.

### Bug Fixes

* start the abandon deadline at the first byte, not at the request ([#29](https://github.com/xabierlameiro/next-leak/issues/29)) ([bcc8c8d](https://github.com/xabierlameiro/next-leak/commit/bcc8c8d23947a9928c11adb93549237219677b8c))

## [0.3.0](https://github.com/xabierlameiro/next-leak/compare/v0.2.0...v0.3.0) (2026-07-25)


### Features

* report peak memory under load and let the run set the heap limit ([#26](https://github.com/xabierlameiro/next-leak/issues/26)) ([cc1e59f](https://github.com/xabierlameiro/next-leak/commit/cc1e59f8f65c1ca1ca72d65affc001effd71a307))

## [0.2.0](https://github.com/xabierlameiro/next-leak/compare/v0.1.3...v0.2.0) (2026-07-25)


### ⚠ BREAKING CHANGES

* verdicts are not comparable across versions. Runs measured before this change used a fixed 256 KiB per-cycle gate and a 3-cycle default; a route reported `stable` by an earlier version may report `leak` here, and the reverse. Re-measure rather than comparing old reports to new ones.

### Features

* scale the leak threshold with load and make the measurement regime explicit ([#21](https://github.com/xabierlameiro/next-leak/issues/21)) ([ecb8182](https://github.com/xabierlameiro/next-leak/commit/ecb818286b897c9e373a8dddf019f0778c3eafd2))


### Bug Fixes

* keep release tags on the v0.1.3 convention the repo already published ([#25](https://github.com/xabierlameiro/next-leak/issues/25)) ([3ab70c7](https://github.com/xabierlameiro/next-leak/commit/3ab70c770ec8fbfb573bb8ae722ab3e93c988273))

## [0.1.3](https://github.com/xabierlameiro/next-leak/compare/v0.1.2...v0.1.3) (2026-07-22)


### Bug Fixes

* announce a duration range and stop measuring static asset routes ([#11](https://github.com/xabierlameiro/next-leak/issues/11)) ([133b8ca](https://github.com/xabierlameiro/next-leak/commit/133b8ca92c18158d2650a927590f79c5c6dc784a))
* clear remaining sonar findings and dev dependency advisories ([d87c834](https://github.com/xabierlameiro/next-leak/commit/d87c834251993f647ccd9a9ff28774ae51dba86d))

## [0.1.2](https://github.com/xabierlameiro/next-leak/compare/v0.1.1...v0.1.2) (2026-07-21)


### Bug Fixes

* remove race in abandonment test that flaked under CI load ([5dae0f8](https://github.com/xabierlameiro/next-leak/commit/5dae0f8c6995dc9274e4b87f8b0a19c0338957e8))
* use setup-node v6 and npm 11.5+ for trusted publishing ([dcccaf8](https://github.com/xabierlameiro/next-leak/commit/dcccaf801d78665bc5b2d15f8538793f1f08fad4))

## [0.1.1](https://github.com/xabierlameiro/next-leak/compare/v0.1.0...v0.1.1) (2026-07-21)


### Bug Fixes

* bundle autocannon so consumers get the patched dependency tree ([c378e55](https://github.com/xabierlameiro/next-leak/commit/c378e5502a7cc0f71ce927800bdf0cebf50b1cce))
* sync lockfile with autocannon moved to devDependencies ([bfdd4f7](https://github.com/xabierlameiro/next-leak/commit/bfdd4f7b9090d487a5174d4cd021f6acdc334d99))
