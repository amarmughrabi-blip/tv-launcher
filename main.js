'use strict';

/**
 * App entry.
 *
 * One window with two surfaces: the launcher grid, and a WebContentsView that
 * a selected site is loaded into. The view is created on demand and destroyed
 * on back, so the launcher never carries a site's state.
 *
 * Ad blocking is attached to the view's session, which is a separate partition
 * so site cookies and storage never mix with the launcher's own.
 *
 * Protected video is not expected to play here — Electron has no renderer EME
 * surface (FINDINGS.md) — so "Open in Brave" is offered on every site rather
 * than only on probe failure.
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, WebContentsView, ipcMain, protocol, net, shell, webContents } = require('electron');

const { GUARD: POPUNDER_GUARD } = require('./src/popunder-guard');
const { CONTROLS_SCRIPT } = require('./src/site-controls');
const channels = require('./src/channels');
const player = require('./src/player');
const store = require('./src/store');
const icons = require('./src/icons');
const favicons = require('./src/favicons');
const brave = require('./src/brave');
const { paths } = require('./src/paths');
const { Blocker } = require('./src/blocker');
const { waitForCdm } = require('./src/drm');

const log = (...a) => console.log('[tv-launcher]', ...a);

// Give the app its own identity and profile directory. Without this it shares
// ~/.config/Electron with every other Electron app on the machine.
app.setName('tv-launcher');
app.setPath('userData', path.join(app.getPath('appData'), 'tv-launcher'));
app.setPath('sessionData', path.join(app.getPath('userData'), 'session'));

/*
 * One instance only.
 *
 * Without this, launching the app again from the menu while it is already
 * running starts a second copy, and both drive the same user-data directory.
 * That produced "Database IO error" from the service worker store and left
 * stale windows — including ones showing an error box — sitting on screen.
 */
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) {
  log('another instance is already running; exiting');
  app.quit();
}

/*
 * An uncaught exception in main otherwise surfaces as a modal error box that
 * sits on screen with no detail. Log it instead, so the failure is visible in
 * the output rather than as something the user has to dismiss.
 */
process.on('uncaughtException', (err) => {
  log(`uncaught: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});

// Must run before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app-icon', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // Streams are fetched through main: broadcast CDNs send no CORS headers, so
  // the player cannot pull segments itself.
  { scheme: player.SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const SITE_PARTITION = 'persist:sites';

/** Last cosmetic injection, exposed for the live check. */
let lastCosmeticsChars = 0;
let cosmeticsApplied = 0;

/**
 * Counts pop-up attempts. The launcher must never hand anything to the system
 * browser on a site's say-so, so the live check watches for the symptom rather
 * than trusting a counter nobody increments.
 */
/**
 * Whether start-up has finished.
 *
 * The renderer asks on load as well as listening for the event. On a slow
 * machine the page can finish loading *after* start-up completes, and a
 * one-shot message would then arrive before anyone was listening, leaving the
 * loading screen up with no way to take it down.
 */
let appReady = false;

ipcMain.handle('app:ready-state', () => appReady);

let popupsAttempted = 0;
let popupsOpenedExternally = 0;
/**
 * How far the controls travel to leave the window. Only a distance now: the
 * controls float inside the strip rather than filling it, so this no longer has
 * to match a CSS height -- it just has to exceed the tallest one.
 */
const CHROME_TRAVEL_PX = 56;

let mainWindow = null;
let siteView = null;
let blocker = null;
/** The bar auto-hides over a site, and the site then gets the whole window. */
let chromeVisible = true;
let chromeTimer = null;
/** Last pointer height reported by the site preload; used by the debug hook. */
let lastPointerY = -1;
/** How long the bar sits idle before hiding, and how near the top reveals it. */
const AUTO_HIDE_MS = 1200;
/**
 * Thin band at the very top. This is deliberately small: a wide one brings the
 * bar back while the pointer is still well down the screen, which reads as the
 * bar appearing at random rather than in response to a deliberate move upward.
 */
const REVEAL_ZONE_PX = 40;
/**
 * Hiding needs a wider band than revealing. Without the gap the bar flickers
 * when the pointer sits right on the boundary, because every mouse move toggles
 * it.
 */
const HIDE_ZONE_PX = 200;
const BOUNDS_ANIM_MS = 280;

/**
 * Space the site view must leave at the top for the shared controls.
 *
 * None. The controls are injected into the page itself (src/site-controls.js),
 * so they sit above it without the site having to give up any space. The site
 * keeps the whole window and never moves when they appear.
 */
function chromeInset() {
  return 0;
}

function showChrome({ schedule = true } = {}) {
  // The controls are their own window now, so revealing means expanding them.
  if (chromeVisible) {
    // Already up, but the geometry still has to agree with that: returning early
    // without re-applying left the bar off-screen while main believed it was
    // visible.
    trackViewBounds();
    if (schedule) scheduleHideChrome();
    return;
  }
  chromeVisible = true;
  sendToLauncher('chrome:visible', true);
  trackViewBounds();
  cancelHideChrome();
  if (schedule) scheduleHideChrome();
}

function hideChrome() {
  if (!siteView || !chromeVisible) return;
  chromeVisible = false;
  sendToLauncher('chrome:visible', false);
  trackViewBounds();
}

/**
 * The cursor poller runs several times a second, so this must not restart an
 * already-pending hide — resetting the timer every tick means it never elapses
 * and the bar never goes away.
 */
function scheduleHideChrome() {
  if (chromeTimer) return;
  chromeTimer = setTimeout(() => {
    chromeTimer = null;
    hideChrome();
  }, AUTO_HIDE_MS);
}

function cancelHideChrome() {
  clearTimeout(chromeTimer);
  chromeTimer = null;
  clearInterval(boundsTimer);
  boundsTimer = null;
}

/*
 * Pointer tracking for reveal-on-hover.
 *
 * Two things that look like they should work, and do not:
 *   - the launcher page gets no pointer events while the bar is hidden, because
 *     the site view covers the whole window;
 *   - screen.getCursorScreenPoint() reports (0, 0) permanently on this Wayland
 *     session, so the reveal zone can never be entered.
 *
 * The pointer position therefore comes from a preload inside the loaded site.
 */
function handleSitePointer(y) {
  if (!siteView) return;
  lastPointerY = y;
  if (y < REVEAL_ZONE_PX) showChrome();
  else if (y > HIDE_ZONE_PX && chromeVisible) scheduleHideChrome();
}

/* ----------------------- site view geometry --------------------------- */

/**
 * The view grows into the space the bar vacates. Jumping the bounds would snap
 * the page by 56px on every reveal, so it is interpolated instead.
 *
 * The bar's own offset is animated on the same clock, from here, rather than by
 * a CSS transition in the renderer. Two independent animations for one piece of
 * state can disagree -- the view moves while the bar does not -- and that leaves
 * either an unreachable bar or a bare gap at the top.
 */
let viewTop = 0;
let chromeOffset = 0;
let boundsTimer = null;

function applyViewBounds() {
  if (!siteView || siteView.webContents.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  siteView.setBounds({ x: 0, y: viewTop, width, height: Math.max(0, height - viewTop) });
}

function applyChromeOffset() {
  sendToLauncher('chrome:offset', chromeOffset);
}

function trackViewBounds({ animate = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const target = chromeInset();
  const targetOffset = chromeVisible ? 0 : -CHROME_TRAVEL_PX;
  const from = viewTop;
  const fromOffset = chromeOffset;

  clearInterval(boundsTimer);
  boundsTimer = null;

  if (!animate || (from === target && fromOffset === targetOffset)) {
    viewTop = target;
    chromeOffset = targetOffset;
    applyViewBounds();
    applyChromeOffset();
    return;
  }

  const delta = target - from;
  const deltaOffset = targetOffset - fromOffset;
  const started = Date.now();
  // Started on the next macrotask, not inline. An interval created directly
  // inside an IPC handler never ticked: the bar was left half-applied and
  // unreachable, which is exactly the "back button will not appear" report.
  setImmediate(() => {
  boundsTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - started) / BOUNDS_ANIM_MS);
    // easeOutCubic: leaves quickly, settles gently.
    const eased = 1 - (1 - t) ** 3;
    viewTop = Math.round(from + delta * eased);
    chromeOffset = Math.round(fromOffset + deltaOffset * eased);
    applyViewBounds();
    applyChromeOffset();
    if (t >= 1) {
      clearInterval(boundsTimer);
      boundsTimer = null;
      viewTop = target;
      chromeOffset = targetOffset;
      applyViewBounds();
      applyChromeOffset();
    }
  }, 16);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'launcher', 'index.html'));

  // The launcher is a fixed-layout TV surface, so a zoom level makes no sense
  // for it. Chromium persists per-host zoom in the profile, which means a zoom
  // set once -- by a stray keypress, or by a debugging aid -- silently survives
  // every restart and leaves the whole UI enormous with no visible cause.
  // Reset it on load and keep it from being stored.
  win.webContents.on('did-finish-load', () => {
    if (win.webContents.getZoomFactor() !== 1) {
      log(`reset launcher zoom ${win.webContents.getZoomFactor()} -> 1`);
      win.webContents.setZoomFactor(1);
    }
    win.webContents.setZoomLevel(0);
  });
  win.webContents.on('zoom-changed', (_event, direction) => {
    if (direction === 'reset') return;
    win.webContents.setZoomLevel(0);
  });

  win.on('closed', () => {
    mainWindow = null;
  });
  return win;
}

/** Create (or replace) the in-window site surface. */
function openSite(url) {
  if (siteView) destroySiteView();

  const view = new WebContentsView({
    webPreferences: {
      partition: SITE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Reports pointer height so the bar can be revealed while a site covers
      // the window. See src/site-pointer-preload.js for why nothing else works.
      preload: path.join(__dirname, 'src', 'site-pointer-preload.js'),
    },
  });

  // Inset below the shared toolbar so Back and "Open in Brave" stay reachable.
  // WebContentsView has no auto-resize, so bounds are maintained thereafter.
  viewTop = chromeInset();
  view.setBounds({
    x: 0,
    y: viewTop,
    width: mainWindow.getContentSize()[0],
    height: Math.max(0, mainWindow.getContentSize()[1] - viewTop),
  });

  // Ads love window.open(): a popup or a new tab is the standard way to try to
  // escape a blocked network request. Handing every one of those to the system
  // browser meant a page could open your browser at will, with no click of
  // yours involved -- the launcher was a way to launch anything. Deny them
  // outright; "Open in Brave" remains the deliberate way out.
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    popupsAttempted += 1;
    log(`blocked pop-up to ${target.slice(0, 90)}`);
    return { action: 'deny' };
  });

  view.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith('http')) {
      // Non-http schemes are how ad scripts try to reach the system browser.
      event.preventDefault();
      log(`blocked scheme navigation to ${target.slice(0, 90)}`);
    }
  });

  // Fullscreen is for the video. The page also watches the Fullscreen API, but
  // a player that goes fullscreen at the window level never fires those events,
  // and controls sitting over the video are the first thing to spoil it.
  const setFullscreen = (on) => {
    if (siteView !== view || view.webContents.isDestroyed()) return;
    view.webContents
      .executeJavaScript(`window.__tvlFullscreen && window.__tvlFullscreen(${Boolean(on)})`)
      .catch(() => {});
  };
  view.webContents.on('enter-html-full-screen', () => setFullscreen(true));
  view.webContents.on('leave-html-full-screen', () => setFullscreen(false));

  // A remote control's back button arrives as Escape or Backspace, and the
  // launcher page is not focused while a site is, so catch it here.
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape' || (input.key === 'Backspace' && !input.control)) {
      event.preventDefault();
      closeSite();
    }
  });

  mainWindow.contentView.addChildView(view);
  siteView = view;
  showChrome();

  // Hide the ads that live in the page markup. Network blocking alone leaves
  // them behind as invisible overlays that swallow clicks meant for the site.
  // Re-applied on every navigation because a single injection would not survive
  // the page replacing its own document.
  const applyCosmetics = async () => {
    if (siteView !== view || view.webContents.isDestroyed()) return;

    // Re-arm the pop-under guard. The preload gets there first, but a page that
    // redefines window.open after load would otherwise get a working one back.
    try {
      await view.webContents.executeJavaScript(POPUNDER_GUARD);
    } catch (err) {
      log(`pop-under guard not armed: ${err.message}`);
    }

    // (Re)install the controls. A navigation replaces the page's DOM, so these
    // have to go in again for every document.
    try {
      await view.webContents.executeJavaScript(CONTROLS_SCRIPT);
    } catch (err) {
      log(`site controls not installed: ${err.message}`);
    }

    if (!blocker || !blocker.ready) return;
    const current = view.webContents.getURL();
    if (!current || !current.startsWith('http')) return;
    const { styles } = blocker.cosmeticsFor(current);
    if (!styles) return;
    try {
      await view.webContents.insertCSS(styles);
      lastCosmeticsChars = styles.length;
      cosmeticsApplied += 1;
      log(`hid ad elements on ${current.slice(0, 60)} (${styles.length} bytes of CSS)`);
    } catch (err) {
      log(`could not apply cosmetic CSS: ${err.message}`);
    }
  };
  view.webContents.on('did-finish-load', applyCosmetics);
  view.webContents.on('did-navigate-in-page', (event, target, isMainFrame) => {
    if (isMainFrame) applyCosmetics();
  });

  view.webContents.loadURL(url).catch((err) => log(`load failed: ${err.message}`));

  mainWindow.on('resize', () => trackViewBounds({ animate: false }));
  mainWindow.on('maximize', () => trackViewBounds({ animate: false }));
  mainWindow.on('unmaximize', () => trackViewBounds({ animate: false }));

  sendToLauncher('site:opened', { url, title: '' });
  view.webContents.on('page-title-updated', (_e, title) => {
    if (siteView === view) sendToLauncher('site:opened', { url, title });
  });

  return { ok: true, url };
}

function destroySiteView() {
  if (!siteView) return;
  clearTimeout(chromeTimer);
  chromeTimer = null;

  // The window's 'closed' event nulls mainWindow before 'window-all-closed'
  // fires, so this can run with no window at all. Guard every use of it.
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Drop the resize listeners too, or they accumulate on every open and keep
    // pointing at a destroyed view.
    mainWindow.removeListener('resize', trackViewBounds);
    mainWindow.removeListener('maximize', trackViewBounds);
    mainWindow.removeListener('unmaximize', trackViewBounds);
    mainWindow.contentView.removeChildView(siteView);
  }

  if (!siteView.webContents.isDestroyed()) siteView.webContents.close();
  siteView = null;
  chromeVisible = true;
}

function sendToLauncher(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/* ------------------------------- IPC ---------------------------------- */

// The site CRUD helpers act on whichever profile is active, so switching
// profiles is just a state change followed by a reload.
ipcMain.handle('profiles:list', () => store.listProfiles());
ipcMain.handle('profiles:create', (_e, { name }) => store.createProfile(name));
ipcMain.handle('profiles:rename', (_e, { id, name, fields }) => store.renameProfile(id, name, fields || {}));
ipcMain.handle('profiles:delete', (_e, { id }) => store.deleteProfile(id));
ipcMain.handle('profiles:activate', (_e, { id }) => store.setActiveProfile(id));
ipcMain.handle('profiles:avatar', (_e, { id, avatar }) => store.setProfileAvatar(id, avatar));

ipcMain.handle('sites:list', () => store.load());

ipcMain.handle('sites:add', (_e, { url, label, icon }) => store.add(url, label, icon));

ipcMain.handle('sites:update', (_e, { url, label, icon }) => {
  // Only the label and icon are patchable; the link itself is the identity of
  // the record and is preserved across every edit.
  return store.update(url, { label, icon });
});

ipcMain.handle('sites:remove', (_e, { url }) => store.remove(url));
ipcMain.handle('sites:reorder', (_e, { url, direction }) => store.reorder(url, direction));

ipcMain.handle('icon:store', (_e, { sourcePath }) => {
  const name = icons.storeIcon(sourcePath, icons.electronCodec());
  return { name };
});

// The picked file has no dependable path once it crosses context isolation, so
// its bytes are sent instead and normalised from those.
ipcMain.handle('icon:store-bytes', (_e, { bytes, sourcePath }) => {
  const codec = icons.electronCodec();
  const byBytes = bytes ? icons.storeIconBytes(new Uint8Array(bytes), codec) : null;
  const name = byBytes || (sourcePath ? icons.storeIcon(sourcePath, codec) : null);
  return { name };
});

ipcMain.handle('icon:choose', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose an icon',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  });
  if (result.canceled || !result.filePaths.length) return { name: null };
  return { name: icons.storeIcon(result.filePaths[0], icons.electronCodec()) };
});

ipcMain.handle('favicon:get', async (_e, { url }) => {
  const file = await favicons.fetchIcon(url, { net });
  if (!file) return null;
  return `app-icon://favicon/${path.basename(file)}`;
});

ipcMain.on('site:pointer', (_e, { y } = {}) => handleSitePointer(Number(y) || 0));

/*
 * Clicks from the controls injected into the page. They arrive as a CustomEvent
 * on `document`, forwarded by the site's preload, because injected script runs
 * in the page's world and cannot reach ipcRenderer itself.
 *
 * 'toggle' flips the pair and holds it open until the user dismisses it, so a
 * deliberate toggle is not undone by the auto-hide a moment later.
 */
ipcMain.on('site:control', (_e, { action } = {}) => {
  if (!siteView) return;
  if (action === 'back') {
    destroySiteView();
    sendToLauncher('site:closed');
    return;
  }
  if (action === 'brave') {
    const current = siteView.webContents.getURL();
    if (current) brave.open(current, { dataRoot: paths.appDir(), log });
    return;
  }
  // 'toggle' is handled in the page itself, on the click's own tick. Routing it
  // through here meant it had to be re-asserted against the auto-hide, which is
  // why the controls used to open and close on their own.
});

ipcMain.handle('site:open', (_e, { url }) => openSite(url));

/* --- live TV ---------------------------------------------------------------- */

// The list is the same for every profile, so it is loaded once and read whole.
// 453 records is small enough that filtering client-side costs nothing and saves
// a round trip per tab switch.
ipcMain.handle('channels:get', () => ({
  grouped: channels.grouped(),
  summary: channels.summary(),
}));

/**
 * Play a channel in the player window.
 *
 * Looks the channel up by URL rather than trusting a name from the renderer:
 * the renderer is the least trustworthy party involved, and this is what decides
 * which URL gets fetched.
 */
ipcMain.handle('channels:play', (_e, { url }) => {
  const channel = channels.findByUrl(url);
  if (!channel) return { ok: false, error: 'unknown channel' };
  const result = player.open(channel, mainWindow);
  if (result.ok && !mainWindow.isDestroyed()) mainWindow.hide();
  return result;
});

// Switching from inside the player. Resolved by URL, never by name: the
// renderer is the least trustworthy party involved and this decides what is
// fetched.
ipcMain.on('player:switch', (_e, { url } = {}) => {
  const channel = channels.findByUrl(url);
  if (!channel) return;
  player.send(channel);
});

ipcMain.handle('player:close', () => {
  player.close();
  return { ok: true };
});

ipcMain.handle('player:toggle-fullscreen', (_e, { on } = {}) => {
  if (!player.isOpen()) return { ok: false };
  const target = playerWindowRef();
  if (!target) return { ok: false };
  target.setFullScreen(on === undefined ? !target.isFullScreen() : Boolean(on));
  return { ok: true, fullscreen: target.isFullScreen() };
});

function playerWindowRef() {
  // The player owns its window; main only needs a handle for fullscreen.
  const all = BrowserWindow.getAllWindows();
  return all.find((w) => w !== mainWindow && !w.isDestroyed()) || null;
}

ipcMain.on('player:report', (_e, payload) => {
  if (!payload) return;
  // The page announcing itself is what releases the queued channel: a message
  // sent before the page has run is simply dropped.
  if (payload.ready) {
    player.onPageReady();
    // Only now can the list be handed over: the same lost-message problem the
    // first channel had.
    player.setChannels(channels.grouped());
  }
  if (payload.error) log(`player: ${JSON.stringify(payload)}`);
});
ipcMain.handle('site:back', () => {
  closeSite();
  return { ok: true };
});

/** Leave the site, from the launcher, the injected controls, or a remote. */
function closeSite() {
  destroySiteView();
  sendToLauncher('site:closed');
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
}
ipcMain.handle('site:current', () => {
  if (!siteView || siteView.webContents.isDestroyed()) return null;
  return {
    url: siteView.webContents.getURL(),
    title: siteView.webContents.getTitle(),
    loading: siteView.webContents.isLoading(),
  };
});

// The launcher reports pointer state on the bar itself, and whether the bar is
// showing. The site view grows into the space the bar vacates so a page really
// does fill the window.
ipcMain.handle('chrome:visible', (_e, visible) => {
  if (visible === false) hideChrome();
  return { ok: true, inset: chromeInset() };
});

// Escape should get the user out whatever has focus, not only when the site
// surface happens to be the focused one.
app.on('web-contents-created', (_event, contents) => {
  contents.on('before-input-event', (event, input) => {
    if (!siteView || contents !== siteView.webContents) return;
    if (input.type !== 'keyDown') return;
    const back = input.key === 'Escape' || (input.key === 'Backspace' && !input.control);
    const altLeft = input.key === 'Left' && input.alt;
    if (back || altLeft) {
      event.preventDefault();
      closeSite();
    }
  });
});

ipcMain.handle('chrome:hover', (_e, hovering) => {
  if (!siteView) return { ok: true };
  if (hovering) {
    // Pointer is on the bar: keep it up until it leaves.
    cancelHideChrome();
    showChrome({ schedule: false });
  } else {
    scheduleHideChrome();
  }
  return { ok: true, inset: chromeInset() };
});

ipcMain.handle('brave:available', () => Boolean(brave.detect()));

ipcMain.handle('brave:open', (_e, { url }) =>
  brave.open(url, { dataRoot: paths.appDir(), log }),
);

/* ------------------------------ startup -------------------------------- */

/*
 * Debug-only: lets a verification script inject a real pointer event into the
 * site view, because reveal-on-hover is handled in this process and cannot be
 * exercised by dispatching a DOM event in the launcher page.
 */
if (process.env.TVL_DEBUG_INPUT === '1') {
  // Position the cursor logically so the reveal logic can be exercised without
  // a physical pointer. Chromium delivers no pointer events to
  // before-input-event, so the poller is the only thing that can be driven.
  ipcMain.handle('debug:mouse-move', (_e, { y = 10 } = {}) => {
    if (!siteView) return { ok: false };
    handleSitePointer(y);
    return { ok: true };
  });
  ipcMain.handle('debug:cosmetics', () => ({
    lastStyles: lastCosmeticsChars,
    applied: cosmeticsApplied,
  }));

  ipcMain.handle('debug:blocker', () => (blocker ? blocker.summary : null));

  // sendInputEvent produces a trusted event with user activation, which is what
  // pop-under code gates on. Synthetic DOM events never carry it, so a scripted
  // probe cannot reproduce a pop-under.
  ipcMain.handle('debug:real-click', async (_e, { x = 550, y = 400 } = {}) => {
    if (!siteView || siteView.webContents.isDestroyed()) return { ok: false };
    const wc = siteView.webContents;
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return { ok: true };
  });

  ipcMain.handle('debug:player', async () => {
    if (!player.isOpen()) return { open: false };
    const w = playerWindowRef();
    const state = await w.webContents.executeJavaScript(`(() => {
      const v = document.getElementById('video');
      return JSON.stringify({
        t: Number(v.currentTime.toFixed(2)),
        w: v.videoWidth, h: v.videoHeight,
        paused: v.paused, ready: v.readyState,
        problem: !document.getElementById('problem').hidden,
      });
    })()`).catch((e) => JSON.stringify({ err: e.message }));
    return { open: true, fullscreen: w.isFullScreen(), state: JSON.parse(state) };
  });

  ipcMain.handle('debug:player-pixels', async () => {
    if (!player.isOpen()) return { ok: false };
    const w = playerWindowRef();
    return w.webContents.executeJavaScript(`(async () => {
      const v = document.getElementById('video');
      for (let i = 0; i < 25 && v.currentTime < 0.3; i++) await new Promise(r => setTimeout(r, 200));
      const c = document.createElement('canvas');
      c.width = 160; c.height = 90;
      const g = c.getContext('2d');
      g.drawImage(v, 0, 0, 160, 90);
      const d = g.getImageData(0, 0, 160, 90).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 24) lit++;
      return JSON.stringify({ nonBlackPct: Math.round((lit / (d.length / 4)) * 100), t: Number(v.currentTime.toFixed(2)) });
    })()`).catch((e) => ({ ok: false, err: e.message }));
  });

  ipcMain.handle('debug:player-ui', async () => {
    if (!player.isOpen()) return { open: false };
    const w = playerWindowRef();
    return w.webContents.executeJavaScript(`(() => {
      const list = document.getElementById('channels');
      const genresSlide = document.getElementById('slide-genres');
      const channelsSlide = document.getElementById('slide-channels');
      const back = document.getElementById('back').getBoundingClientRect();
      return JSON.stringify({
        genreRows: genresSlide.querySelectorAll('.ch-genre').length,
        channelRows: channelsSlide.querySelectorAll('.ch[data-url]').length,
        genresHidden: genresSlide.hidden,
        channelsHidden: channelsSlide.hidden,
        slideTitle: document.getElementById('slide-title').textContent,
        listOpen: !list.hidden,
        listLeft: Math.round(list.getBoundingClientRect().left),
        backLeft: Math.round(back.left), backTop: Math.round(back.top),
        current: (channelsSlide.querySelector('.ch.is-current')||{}).textContent || null,
        idle: document.getElementById('chrome').classList.contains('is-idle'),
        cursorHidden: getComputedStyle(document.body).cursor === 'none',
      });
    })()`).catch((e) => ({ open: true, err: e.message }));
  });

  ipcMain.handle('debug:player-pick', async (_e, { index } = {}) => {
    if (!player.isOpen()) return { ok: false };
    const w = playerWindowRef();
    return w.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.ch')];
      const row = rows[${Number(index) || 0}];
      if (!row) return JSON.stringify({ ok: false });
      row.click();
      return JSON.stringify({ ok: true, name: row.textContent.trim().slice(0,30) });
    })()`).catch((e) => ({ ok: false, err: e.message }));
  });

  ipcMain.handle('debug:player-toggle', async () => {
    if (!player.isOpen()) return { ok: false };
    const w = playerWindowRef();
    return w.webContents
      .executeJavaScript("document.getElementById('toggle').click(); 'clicked'")
      .catch((err) => ({ ok: false, err: err.message }));
  });

  ipcMain.handle('debug:launcher-visible', () => ({
    visible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    focused: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
  }));

  ipcMain.handle('debug:player-pick-genre', async (_e, { genre } = {}) => {
    if (!player.isOpen()) return { ok: false };
    const w = playerWindowRef();
    return w.webContents
      .executeJavaScript(`(() => {
        const row = document.querySelector('.ch-genre[data-genre="${String(genre)}"]');
        if (!row) return 'no such genre';
        row.click();
        return 'clicked';
      })()`)
      .catch((err) => ({ ok: false, err: err.message }));
  });

  ipcMain.handle('debug:popups', () => ({ attempted: popupsAttempted }));

  // Every live webContents, so a check can prove the site did not spawn a
  // window of its own behind the launcher's back.
  ipcMain.handle('debug:windows', () => {
    const all = webContents.getAllWebContents();
    return all.map((w) => ({
      type: w.getType(),
      url: w.getURL().slice(0, 80),
    }));
  });

  // Run script inside the site view. The live ad checks need to act on the
  // loaded page itself; probing from the launcher would exercise the wrong
  // renderer entirely.
  ipcMain.handle('debug:site-eval', async (_e, { code }) => {
    if (!siteView || siteView.webContents.isDestroyed()) return null;
    try {
      return await siteView.webContents.executeJavaScript(code, true);
    } catch (err) {
      return `error: ${err.message}`;
    }
  });

  // Counts anything handed to the system browser. Installed unconditionally:
  // if a site ever reaches the browser, the count has to show it even when
  // nobody is running a check.
  const realOpenExternal = shell.openExternal;
  shell.openExternal = (target) => {
    popupsOpenedExternally += 1;
    log(`system browser opened by ${target.slice(0, 90)}`);
    return realOpenExternal.call(shell, target);
  };

  ipcMain.handle('debug:external-opens', () => ({ openedExternally: popupsOpenedExternally }));

  ipcMain.handle('debug:chrome-state', () => ({
    visible: chromeVisible,
    hasSite: Boolean(siteView),
    lastPointerY,
    viewTop,
    chromeOffset,
  }));
  // Dispatches a genuine pointer move into the loaded page and reports whether
  // the preload picked it up, so the real path is checked rather than assumed.
  ipcMain.handle('debug:probe-pointer', async (_e, { y = 10, scroll = false } = {}) => {
    // `y` is validated here rather than defaulted silently: a missing position
    // used to become 10, which made every check probe the very top of the
    // screen no matter what it asked for.
    if (!siteView || siteView.webContents.isDestroyed()) return { ok: false };
    /*
     * Dispatches inside the page rather than through sendInputEvent. Injected
     * hardware-level input is not delivered to a window that lacks OS focus,
     * which made this check fail for reasons unrelated to the preload. A DOM
     * event still exercises the real chain: preload listener -> IPC -> handler.
     *
     * `scroll` dispatches a scroll instead of a move, so the check can prove
     * that scrolling does not bring the bar back.
     */
    lastPointerY = -1;
    const event = scroll
      ? `window.dispatchEvent(new Event('scroll'))`
      : `window.dispatchEvent(new MouseEvent('mousemove', { clientY: ${Number(y)} }))`;
    try {
      await siteView.webContents.executeJavaScript(event);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    await new Promise((r) => setTimeout(r, 250));
    return { ok: lastPointerY !== -1, lastPointerY };
  });
}

/**
 * Debug hook: TVL_CAPTURE=<path> writes a PNG of the launcher once it has
 * painted. Lets the UI be inspected without depending on what happens to be on
 * screen, which is otherwise indistinguishable from a blank render.
 */
function maybeCapture(window) {
  const target = process.env.TVL_CAPTURE || process.env.TVL_VERIFY;
  if (!target) return;

  // Surface renderer failures, otherwise a blank capture gives no clue why.
  window.webContents.on('console-message', (_e, level, message, line, source) => {
    log(`renderer[${level}] ${message} (${source}:${line})`);
  });
  window.webContents.on('preload-error', (_e, preload, err) => {
    log(`preload error in ${preload}: ${err.message}`);
  });

  // TVL_VERIFY points at a renderer script to run against the live UI, so the
  // interaction paths can be checked without a display.
  const verify = process.env.TVL_VERIFY;
  // Verification scripts run against the live UI and may bootstrap a site first,
  // so the settle window has to outlast their slowest path, not just first paint.
  const settleMs = Number(process.env.TVL_SETTLE_MS || 12000);

  setTimeout(async () => {
    if (verify) {
      try {
        const script = fs.readFileSync(verify, 'utf8');
        const result = await window.webContents.executeJavaScript(script, true);
        log(`verify: ${typeof result === 'string' ? result : JSON.stringify(result)}`);
        if (process.env.TVL_SHOT) {
          // webContents.capturePage() does not composite child views, so when a
          // site is open the launcher page would be captured instead of it.
          const target_ =
            siteView && !siteView.webContents.isDestroyed() ? siteView.webContents : window.webContents;
          const shot = await target_.capturePage();
          fs.writeFileSync(process.env.TVL_SHOT, shot.toPNG());
          log(`captured ${siteView ? 'site view' : 'launcher'} to ${process.env.TVL_SHOT}`);
        }
        app.exit(typeof result === 'string' && result.includes('FAIL') ? 1 : 0);
      } catch (err) {
        log(`verify failed: ${err.message}`);
        app.exit(1);
      }
      return;
    }

    if (!target) {
      app.exit(0);
      return;
    }

    try {
      const image = await window.webContents.capturePage();
      fs.writeFileSync(target, image.toPNG());
      const summary = await window.webContents.executeJavaScript(
        `JSON.stringify({
           tiles: document.querySelectorAll('.tile').length,
           api: typeof window.api,
           list: typeof window.api?.listSites,
           emptyHidden: document.getElementById('empty')?.hidden,
           bodyLen: document.body.innerHTML.length,
         })`,
      );
      log(`dom: ${summary}`);
      log(`captured launcher UI to ${target}`);
    } catch (err) {
      log(`capture failed: ${err.message}`);
    }
    app.exit(0);
  }, settleMs);
}

const ICON_ROOTS = () => [paths.iconsDir(), paths.cacheDir()];

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Resolve a requested icon name inside one of the icon roots.
 * Returns null for anything that escapes, including traversal attempts.
 */
function resolveIconFile(name) {
  if (!name) return null;
  for (const root of ICON_ROOTS()) {
    const file = path.join(root, name);
    const resolvedRoot = path.resolve(root);
    if (!path.resolve(file).startsWith(resolvedRoot + path.sep)) continue;
    if (fs.existsSync(file)) return file;
  }
  return null;
}

app.on('second-instance', () => {
  // Surface the window the user already has instead of leaving them to find it.
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

if (isPrimary) app.whenReady().then(async () => {
  paths.ensure();
  favicons.pruneCache();
  player.handler();
  protocol.handle('app-icon', (request) => {
    // basename() strips any directory component, so the name is a single
    // segment before it is joined onto a known root.
    const name = path.basename(new URL(request.url).pathname);
    const file = resolveIconFile(name);
    if (!file) return new Response('', { status: 404 });

    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return new Response(fs.readFileSync(file), { headers: { 'Content-Type': type } });
  });

  mainWindow = createWindow();
  maybeCapture(mainWindow);

  /*
   * Let the loading screen paint before doing anything slow.
   *
   * Parsing the filter lists blocks the main process outright for several
   * seconds, and it happens whether or not this window has been painted. A
   * couple of event-loop turns first means the user is looking at something that
   * says what is happening rather than at a window that has stopped responding.
   */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  await settle();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('boot:note', 'Loading ad blocking');
  }
  await settle();

  // Non-fatal: a missing CDM does not stop the launcher, it only means no site
  // will ever play protected video here.
  const cdm = await waitForCdm({ log, timeoutMs: 45_000 });
  if (!cdm.available) log(`Widevine unavailable (${cdm.reason}) — playback will use Brave`);

  blocker = new Blocker({ log });
  try {
    await blocker.load();
    const { session } = require('electron');
    blocker.attach(session.fromPartition(SITE_PARTITION));
    log('ad blocking active on the site session');
  } catch (err) {
    log(`ad blocking failed to load: ${err.message}`);
  }

  // Startup is done: take the loading screen away.
  appReady = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:ready');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  destroySiteView();
  if (process.platform !== 'darwin') app.quit();
});