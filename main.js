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

/** Space the site view must leave at the top for the shared bar. */
function chromeInset() {
  return chromeVisible ? TOOLBAR_H : 0;
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
    },
  });

  const [width, height] = mainWindow.getContentSize();
  // Inset below the shared toolbar so Back and "Open in Brave" stay reachable.
  // WebContentsView has no auto-resize, so bounds are maintained on resize.
  view.setBounds({ x: 0, y: chromeInset(), width, height: Math.max(0, height - chromeInset()) });

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
  view.webContents.loadURL(url).catch((err) => log(`load failed: ${err.message}`));

  mainWindow.on('resize', trackViewBounds);
  mainWindow.on('maximize', trackViewBounds);
  mainWindow.on('unmaximize', trackViewBounds);

  sendToLauncher('site:opened', { url, title: '' });
  view.webContents.on('page-title-updated', (_e, title) => {
    if (siteView === view) sendToLauncher('site:opened', { url, title });
  });
  return { ok: true, url };
}

function destroySiteView() {
  if (!siteView) return;
  // Drop the resize listeners too, or they accumulate on every open and keep
  // pointing at a destroyed view.
  mainWindow.removeListener('resize', trackViewBounds);
  mainWindow.removeListener('maximize', trackViewBounds);
  mainWindow.removeListener('unmaximize', trackViewBounds);
  mainWindow.contentView.removeChildView(siteView);
  siteView.webContents.close();
  siteView = null;
}

/** Keep the site surface filling the area below the toolbar as the window changes. */
function trackViewBounds() {
  if (!siteView || !mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  const top = chromeInset();
  siteView.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
}

function sendToLauncher(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/* ------------------------------- IPC ---------------------------------- */

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

// The launcher reports whether the shared bar is showing; the site view grows
// into the space it vacates so a page really does fill the window.
ipcMain.handle('chrome:visible', (_e, visible) => {
  chromeVisible = visible !== false;
  trackViewBounds();
  return { ok: true, inset: chromeInset() };
});

ipcMain.handle('brave:available', () => Boolean(brave.detect()));

ipcMain.handle('brave:open', (_e, { url }) =>
  brave.open(url, { dataRoot: paths.appDir(), log }),
);

/* ------------------------------ startup -------------------------------- */

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

app.whenReady().then(async () => {
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