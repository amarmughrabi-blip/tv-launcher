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

## Profiles

A full-screen picker on launch, the way a TV service asks who is watching.
Choose a profile and it opens with that profile's apps.

Each tile shows a picture or, failing that, a coloured initial derived from the
name. `Add Profile` sits at the end of the row. `Manage Profiles` (bottom right)
turns on edit and delete for every tile; delete asks once before it acts, and
the last profile cannot be removed so there is always somewhere to go.

Profiles can be renamed and given a picture, independently of their apps.
Switching profiles reloads the launcher against that set.

Storage is `profiles.json`:

```json
{
  "active": "default",
  "profiles": [{ "id": "default", "name": "watching stuff", "avatar": null, "sites": [] }]
}
```

A pre-existing `sites.json` is folded into a default profile on first run and
left on disk as a backup.

## Layout

```
main.js                      app entry
src/
  paths.js                   data locations
  store.js                   profiles and site records
  icons.js                   icon normalisation and storage
  blocker.js                 filter engine + session bridge
  brave.js                   Brave fallback for playback
  favicons.js                favicon fetch and cache
  drm.js                     Widevine component readiness
  key-system.js              key-system probe
  site-pointer-preload.js    pointer height, for revealing the bar
scripts/
  setup-ecs.sh               fetch and verify the ECS runtime
  run.sh                     launch on the ECS runtime
  install-desktop.js         application-menu entry and icon
  verify.sh                  run a check against a throwaway profile
  drm-gate.js                Phase 1 gate
  verify-*.js                live checks
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