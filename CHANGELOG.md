# Changelog

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
