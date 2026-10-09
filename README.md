# tv-launcher

A TV-style launcher for streaming sites that opens a site inside its own window
with ads, pop-ups, and unwanted scripts blocked.

## Status

**Phase 1 gate failed — see [FINDINGS.md](FINDINGS.md).** Protected video cannot
play inside an Electron window: `navigator.mediaKeys` is undefined in the
renderer and Widevine has been disabled upstream since Electron 8. The gate that
was built to catch exactly this caught it before any of the UI was written.

The storage and ad-blocking layers are unaffected, verified, and independent of
which shell is used.

## What is verified

| | |
|---|---|
| Ad blocking | 122,738 filters, confirmed live in a real `BrowserWindow` — trackers cancelled, first-party assets served |
| Exception rules | `@@` exceptions override blocks for their own host only |
| Main-frame navigation | never blocked |
| Storage | `sites.json` records; legacy bare-URL format migrates and is rewritten exactly once; corrupt files are preserved and recovered from |
| Icon store | hash-addressed, deduplicated, scaled to a 256px bound with aspect preserved, refuses names that could escape the store |

25/25 tests pass.

## Layout

```
main.js                      app entry (not yet written)
src/
  paths.js                   data locations
  store.js                   site records, migration, CRUD
  icons.js                   icon normalisation and storage
  blocker.js                 filter engine + session bridge
  drm.js                     Widevine component readiness
  key-system.js              key-system probe
  brave.js                   Brave fallback (not yet written)
scripts/
  setup-ecs.sh               fetch and verify the ECS runtime
  run.sh                     launch on the ECS runtime
  drm-gate.js                Phase 1 gate — kept as a regression check
  verify-blocking.js         live blocking verification
test/                        node:test suites
vendor/ecs-dist/             the runtime (gitignored)
```

## Running

```sh
./scripts/setup-ecs.sh        # fetch the ECS runtime, install deps
npm test                      # unit tests
./scripts/run.sh scripts/verify-blocking.js   # live blocking check
./scripts/run.sh scripts/drm-gate.js          # DRM gate (currently reports FAIL)
```

## Why the runtime is invoked by path

`scripts/run.sh` executes `vendor/ecs-dist/electron` directly rather than going
through the `electron` npm package. That package is only a binary downloader and
path resolver — Electron's runtime injects `require('electron')` into the app
itself — and routing through `node_modules` would let any future `npm install`
quietly replace a Widevine-capable runtime with a stock one.

## Next

Decide between the options in [FINDINGS.md](FINDINGS.md) before writing more
here. Option B (a lightweight GTK launcher that hands playback to Brave) needs
roughly an afternoon. Option C (CEF) is the only remaining route to in-window
DRM and is a much larger project.