# Phase 1 gate result: FAIL

**Question the gate answered:** does an Electron-based runtime expose a usable
Widevine key system, so protected video can play inside the application window?

**Answer: no.** Playback of DRM content inside an Electron window is not
achievable with released binaries. This is the go/no-go for the project, and the
gate is where it was meant to be caught.

Run `./scripts/run.sh scripts/drm-gate.js` to reproduce.

---

## What works

The Widevine side of the setup succeeds completely, which is what makes this
misleading at a glance:

- ECS `44.5.1+wvcus` installs and runs (`v44.5.1`, Chromium `152.0.7977.130`)
- The CDM downloads via Google's component updater
- `components.whenReady()` resolves `true`
- Chromium logs `Component ready, version 4.10.3112.0`
- Chromium logs `Registering Widevine CDM 4.10.3112.0 with Chrome`

The library is installed, registered, and reported as ready. None of it
matters, because the renderer's EME surface does not exist.

## What fails

```
navigator.mediaKeys                      -> undefined
navigator.requestMediaKeySystemAccess()  -> TypeError
   "The object must have a callable @@iterator property."
```

`navigator.mediaKeys` is `undefined` in a secure context. In any working
Chromium build that property is present. Its absence is the actual failure; the
`@@iterator` error is just how the broken binding surfaces when it tries to
convert its arguments.

The error is not caused by the configuration passed:

| Config tried | Result |
|---|---|
| `{}` | `@@iterator` |
| `{ videoCapabilities: [] }` | `@@iterator` |
| `{ initDataTypes: ['cenc'], videoCapabilities: [...] }` | `@@iterator` |
| `+ sessionTypes: ['temporary']` | `@@iterator` |
| `+ distinctiveIdentifier / persistentState` | `@@iterator` |
| full SABR config | `@@iterator` |

An empty array still fails, so this is not a malformed-argument problem.

## What it is not

- **Not origin-specific.** Fails identically on `file://` and `http://127.0.0.1`,
  both secure contexts.
- **Not headless.** These were hidden `BrowserWindow`s, not headless mode.
- **Not a version regression.** Reproduced on ECS `44.5.1` (Chromium 152) *and*
  ECS `42.11.10` — a different Chromium major.
- **Not fixable by switches.** `--enable-blink-features=EncryptedMedia`,
  `--enable-blink-features=EncryptedMedia,MediaKeySystemConfig`,
  `--enable-experimental-web-platform-features`, and `webPreferences.plugins`
  were all tried. `navigator.mediaKeys` stays `undefined` in every case.

## Root cause

Upstream, not environmental:

> Widevine has been disabled since Electron 8 so we should remove the
> documentation about it. #20211 is a tracking issue to re-enable support for
> Widevine, but given complications around licensing it may never make sense to
> re-enable this in Electron.
>
> — [electron/electron#35980](https://github.com/electron/electron/pull/35980)

ECS re-enables CDM *installation and registration* at the browser-process level.
It does not restore the Blink runtime surface that EME playback depends on.
Those are separate things, and only the first one is present.

A March 2026 PR ([electron/electron#50046](https://github.com/electron/electron/pull/50046))
adds opt-in Widevine CDM paths behind a build flag, marked experimental and off by
default in released builds. Adopting it requires building Electron from source
with `enable_widevine`, and distributors remain responsible for Google's licensing
and VMP requirements — so that is a legal question before it is an engineering one.

## Impact on the specification

- **Section 4, DRM handling** — cannot be implemented as written. The probe is
  moot: there is no key system to probe for. Pre-routing sites on a probe result
  is impossible.
- **The core premise** — "video plays inside the window" does not hold. Pages
  would load and render in-window, with ads blocked, but protected video would
  not play.
- **Sections 2, 5, 7, 8** — unaffected. The launcher, the ad blocking, and the
  storage layer all stand.

## What survives

Verified working, 16/16 tests passing, engine-independent of the shell choice:

- `src/store.js` — `sites.json` records, transparent migration from the legacy
  bare URL array, written back exactly once, corrupt-file recovery
- `src/icons.js` — hash-addressed icon store, 256px normalisation
- `src/blocker.js` — `@ghostery/adblocker` 2.20.1, 122,738 network filters,
  exception precedence verified correct, main-frame navigation never blocked
- `scripts/drm-gate.js` — keep this as the regression check; if a future
  Electron release restores EME, it will say so

The storage and blocking layers are the majority of the non-UI work and are
portable to any shell.

## Options

**A — Electron as launcher, Brave handoff for playback.**
Everything except the "video in-window" premise. Costs ~200MB disk and
~250-350MB RAM for what is fundamentally a grid of tiles.

**B — Lightweight GTK launcher, Brave handoff.**
Same user-visible outcome as A, roughly 3 hours of work, a fraction of the
resource cost. This was always the planned fallback and remains the sane
default.

**C — CEF instead of Electron.**
The only remaining technical route to DRM in-window: CEF is not Electron and does
expose EME with Widevine configuration. The cost is a C++ codebase, a much
larger binary distribution, and the same CDM licensing question. This is a
multi-week project, not an evening.

## Recommendation

Take **B** unless in-window video is the entire point of the product. It
delivers an ad-free TV-style launcher for streaming sites — the actual stated
goal — in an afternoon, without depending on a DRM workaround that upstream
Electron has deliberately declined to support.

If in-window video is non-negotiable, **C** is the only honest route and it
should be scoped as a new project rather than a continuation of this one.