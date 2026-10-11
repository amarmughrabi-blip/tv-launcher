'use strict';

/**
 * The live TV player: its own window, playing its own stream.
 *
 * Two things make this a separate window rather than part of the launcher:
 *
 *  - The launcher page's own security policy does not allow media, so video
 *    cannot play there at all.
 *  - A site is a WebContentsView *inside* the main window. That is the wrong
 *    shape here: watching a channel wants the whole screen to itself.
 *
 * Streams are fetched through the `tv://` scheme, which main resolves to the
 * real https URL. That is not decoration. Broadcast CDNs generally send no
 * CORS headers -- Al Jazeera sends none at all -- so hls.js fetching segments
 * straight from the renderer would be blocked. Proxying in main sidesteps that,
 * and it makes the plain-http channels (95 of the 453) behave the same as the
 * https ones instead of tripping mixed-content rules.
 */

const path = require('node:path');
const { BrowserWindow, protocol, net } = require('electron');

/** Scheme the player page hands to hls.js in place of a real origin. */
const SCHEME = 'tv';

let win = null;

/**
 * Whether the player page has loaded, and what it should be told once it has.
 *
 * The first channel has to wait for this. Sending as soon as the window exists
 * delivers the message to a page that has not run yet, and it is simply lost --
 * the window then opens onto nothing at all, which looks like a broken channel
 * rather than a missed message.
 */
let pageReady = false;
let pending = null;
/** The channel list, sent once the page can take it. */
let pendingList = null;

function flush() {
  if (!pageReady || !isOpen()) return;
  if (pendingList) {
    win.webContents.send('player:channels', pendingList);
    pendingList = null;
  }
  if (pending) {
    const payload = pending;
    pending = null;
    win.webContents.send('player:load', payload);
  }
}

/** The page tells us it is listening. Called once per load of the page. */
function onPageReady() {
  pageReady = true;
  flush();
}

/**
 * What the queue is holding, for the checks in scripts/verify-*.js.
 *
 * A message sent to a page that has not finished loading is simply dropped, and
 * nothing on either side looks wrong when that happens. These three values are
 * the only way to tell a lost message from a page that ignored it.
 */
function internals() {
  return {
    pageReady,
    hasPending: Boolean(pending),
    hasPendingList: Boolean(pendingList),
    open: isOpen(),
  };
}

/** Supply the grouped channel list so the player can switch without leaving. */
function setChannels(grouped) {
  pendingList = grouped;
  flush();
}

function resetPageState() {
  pageReady = false;
  pending = null;
}

/**
 * How long a stream fetch may hang before the player is told to stop waiting.
 *
 * Without this the proxy waits on a host that never answers, hls.js waits on the
 * proxy, and the window sits on a black screen saying nothing. A stream that
 * cannot be reached has to fail visibly -- and "could not be reached" is a
 * different answer from "is gone", which is exactly the distinction the channel
 * health counts on.
 */
const STREAM_TIMEOUT_MS = 15000;

/** tv://host/path -> https://host/path, fetched in main so no CORS applies. */
function handler() {
  protocol.handle(SCHEME, async (request) => {
    let target;
    let parsed;
    try {
      parsed = new URL(request.url);
    } catch (err) {
      return new Response(`bad stream url: ${err.message}`, { status: 400 });
    }
    // Keep the scheme the channel actually used. Forcing https on an http://
    // channel turns a working stream into a connection to a port nobody is
    // listening on, which reads as "dead" when it is not.
    const scheme = parsed.protocol === 'http:' ? 'http:' : 'https:';
    target = `${scheme}//${parsed.host}${parsed.pathname}${parsed.search}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
    try {
      // Returned straight through: main's fetch is not subject to CORS, and the
      // body has to stay a stream for live playback rather than buffering.
      return await net.fetch(target, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
      });
    } catch (err) {
      const hung = controller.signal.aborted;
      return new Response(
        hung ? 'stream did not respond' : `stream unreachable: ${err.message}`,
        { status: hung ? 504 : 502 },
      );
    } finally {
      clearTimeout(timer);
    }
  });
}

/** Re-express a channel URL as the scheme the player page can actually fetch. */
function toStreamUrl(url) {
  try {
    const parsed = new URL(url);
    return `${SCHEME}://${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function isOpen() {
  return Boolean(win && !win.isDestroyed());
}

/** Tell the page why a channel failed, in words rather than a code. */
function explain(url, detail) {
  if (!isOpen()) return;
  win.webContents.send('player:explained', { url, ...detail });
}

/**
 * What the page is told about a channel.
 *
 * `url` is the tv:// rewrite the player can actually fetch; `source` is the
 * channel's real url, which is how the page matches it against the list. The
 * two can never be compared directly, or the playing channel is never found.
 */
function payloadFor(channel) {
  return {
    url: toStreamUrl(channel.url),
    source: channel.url,
    name: channel.name,
    res: channel.res || null,
  };
}

/**
 * Open (or retarget) the player. One window, reused between channels: creating
 * a window per channel costs a visible flash and a fresh hls.js instance, and
 * the user is switching between channels with the remote.
 */
function open(channel, parentWindow) {
  if (!channel || !channel.url) return { ok: false, error: 'no channel' };

  if (!isOpen()) {
    win = new BrowserWindow({
      width: Math.max(1024, parentWindow ? parentWindow.getContentSize()[0] : 1280),
      height: Math.max(640, parentWindow ? parentWindow.getContentSize()[1] : 720),
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      // The window must be able to go fullscreen for video, and must be able to
      // take focus so a remote's keys reach it.
      title: 'TV',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'player-preload.js'),
      },
    });

    // Closing is the only way out of a fullscreen window from the keyboard, so
    // it is the primary escape; Escape is handled by the page as well.
    win.on('closed', () => {
      win = null;
      resetPageState();
      // The launcher is hidden while a channel plays, so it has to be shown
      // again -- focus() on a hidden window does nothing, and the viewer is left
      // looking at whatever is behind the app with no way back into it.
      if (parentWindow && !parentWindow.isDestroyed()) {
        parentWindow.show();
        parentWindow.focus();
      }
    });

    resetPageState();
    win.loadFile(path.join(__dirname, '..', 'launcher', 'player.html'));
  }

  // Queued, not sent: on a freshly created window the page is not listening yet.
  pending = payloadFor(channel);
  flush();

  if (!win.isVisible()) win.show();
  win.focus();
  // Watching wants the whole screen. Deferred a moment so the window is mapped
  // before the request, which some compositors drop otherwise.
  setTimeout(() => {
    if (isOpen() && !win.isFullScreen()) win.setFullScreen(true);
  }, 120);
  return { ok: true, name: channel.name };
}

function close() {
  if (isOpen()) win.close();
}

function send(channel) {
  if (isOpen() && channel && channel.url) {
    pending = payloadFor(channel);
    flush();
  }
}

module.exports = {
  handler,
  open,
  close,
  send,
  explain,
  setChannels,
  internals,
  isOpen,
  onPageReady,
  toStreamUrl,
  SCHEME,
};