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
const { app, BrowserWindow, WebContentsView, ipcMain, protocol, net, shell } = require('electron');

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
]);

const SITE_PARTITION = 'persist:sites';
/** Height of the always-visible bar the launcher and the site view share. */
const TOOLBAR_H = 52;

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
 * Generous reveal band. A tight one feels unresponsive because the bar is already
 * gone by the time the pointer reaches the very top of the screen.
 */
const REVEAL_ZONE_PX = 130;
/**
 * Hiding needs a wider band than revealing. Without the gap the bar flickers
 * when the pointer sits right on the boundary, because every mouse move toggles
 * it.
 */
const HIDE_ZONE_PX = 230;
const BOUNDS_ANIM_MS = 280;

/** Space the site view must leave at the top for the shared bar. */
function chromeInset() {
  return chromeVisible ? TOOLBAR_H : 0;
}

function showChrome({ schedule = true } = {}) {
  if (chromeVisible) {
    // Already up; just hold it open rather than restarting the countdown.
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
 * the page by 52px on every reveal, so it is interpolated instead.
 */
let viewTop = 0;
let boundsTimer = null;

function applyViewBounds() {
  if (!siteView || siteView.webContents.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  siteView.setBounds({ x: 0, y: viewTop, width, height: Math.max(0, height - viewTop) });
}

function trackViewBounds({ animate = true } = {}) {
  if (!siteView || !mainWindow || mainWindow.isDestroyed()) return;
  const target = chromeInset();
  const from = viewTop;

  clearInterval(boundsTimer);
  boundsTimer = null;

  if (!animate || from === target) {
    viewTop = target;
    applyViewBounds();
    return;
  }

  const delta = target - from;
  const started = Date.now();
  boundsTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - started) / BOUNDS_ANIM_MS);
    // easeOutCubic: leaves quickly, settles gently.
    viewTop = Math.round(from + delta * (1 - (1 - t) ** 3));
    applyViewBounds();
    if (t >= 1) {
      clearInterval(boundsTimer);
      boundsTimer = null;
      viewTop = target;
      applyViewBounds();
    }
  }, 16);
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

  // Keep the site from navigating the whole app away, and hand external links
  // to the system browser rather than trapping them in the view.
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith('http')) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  // A remote control's back button arrives as Escape or Backspace, and the
  // launcher page is not focused while a site is, so catch it here.
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape' || (input.key === 'Backspace' && !input.control)) {
      event.preventDefault();
      destroySiteView();
      sendToLauncher('site:closed');
    }
  });

  mainWindow.contentView.addChildView(view);
  siteView = view;
  showChrome();
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
ipcMain.handle('profiles:rename', (_e, { id, name }) => store.renameProfile(id, name));
ipcMain.handle('profiles:delete', (_e, { id }) => store.deleteProfile(id));
ipcMain.handle('profiles:activate', (_e, { id }) => store.setActiveProfile(id));

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

ipcMain.handle('site:open', (_e, { url }) => openSite(url));
ipcMain.handle('site:back', () => {
  destroySiteView();
  sendToLauncher('site:closed');
  return { ok: true };
});
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
  ipcMain.handle('debug:chrome-state', () => ({
    visible: chromeVisible,
    hasSite: Boolean(siteView),
    lastPointerY,
  }));
  // Dispatches a genuine pointer move into the loaded page and reports whether
  // the preload picked it up, so the real path is checked rather than assumed.
  ipcMain.handle('debug:probe-pointer', async (_e, { y = 10 } = {}) => {
    if (!siteView || siteView.webContents.isDestroyed()) return { ok: false };
    /*
     * Dispatches inside the page rather than through sendInputEvent. Injected
     * hardware-level input is not delivered to a window that lacks OS focus,
     * which made this check fail for reasons unrelated to the preload. A DOM
     * event still exercises the real chain: preload listener -> IPC -> handler.
     */
    lastPointerY = -1;
    try {
      await siteView.webContents.executeJavaScript(
        `window.dispatchEvent(new MouseEvent('mousemove', { clientY: ${Number(y)} }))`,
      );
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  destroySiteView();
  if (process.platform !== 'darwin') app.quit();
});