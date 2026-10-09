'use strict';

/**
 * Brave fallback for playback.
 *
 * Needed because Electron's renderer has no EME surface (see FINDINGS.md), so
 * protected video cannot play in-window. Sites open in a real Brave instead,
 * which has a working key system.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const FLATPAK_ID = 'com.brave.Browser';

/** Flatpak ids to try, in order of preference for protected playback. */
const FLATPAK_IDS = [
  FLATPAK_ID, // Chromium: the only one here with a working Widevine key system
  'app.zen_browser.zen',
];

const NATIVE_PATHS = [
  '/usr/bin/brave',
  '/usr/bin/brave-browser',
  '/opt/brave.com/brave/brave',
  '/usr/bin/google-chrome',
  '/usr/bin/microsoft-edge',
  '/usr/bin/firefox',
];

let cachedDetect;

/**
 * Find a browser to hand off to.
 *
 * Flatpak apps here are not exported into the host PATH — `/var/lib/flatpak/
 * exports/bin/com.brave.Browser/` is empty — so probing for a binary on disk
 * cannot find them. `flatpak info` is the authoritative check.
 */
function detect({ force = false } = {}) {
  if (cachedDetect && !force) return cachedDetect;

  for (const p of NATIVE_PATHS) {
    if (fs.existsSync(p)) {
      cachedDetect = { kind: 'native', command: p, args: [] };
      return cachedDetect;
    }
  }

  if (fs.existsSync('/usr/bin/flatpak')) {
    for (const id of FLATPAK_IDS) {
      try {
        const res = spawnSync('/usr/bin/flatpak', ['info', id], { stdio: 'ignore' });
        if (res.status === 0) {
          cachedDetect = { kind: 'flatpak', command: '/usr/bin/flatpak', args: ['run', id], id };
          return cachedDetect;
        }
      } catch {
        /* try the next candidate */
      }
    }
  }

  cachedDetect = null;
  return cachedDetect;
}

/**
 * Profile directory for the handoff.
 *
 * A flatpak'd browser mounts $HOME read-only, so it cannot create a profile
 * under XDG_DATA_HOME. Its own .var/app directory is writable, so that is where
 * the dedicated profile has to go. Getting this wrong fails at launch time with
 * a profile that silently never persists.
 */
function profileDir(browser, dataRoot) {
  if (browser.kind === 'flatpak') {
    const home = process.env.HOME || '';
    return path.join(home, '.var', 'app', browser.id || FLATPAK_ID, 'data', 'adblock-launcher-profile');
  }
  return path.join(dataRoot, 'brave-profile');
}

function launchArgs(url, { profile }) {
  return [
    '--user-data-dir', profile,
    '--start-fullscreen',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--autoplay-policy=no-user-gesture-required',
    url,
  ];
}

/** Open a site in a real browser. Returns how it was launched, or null. */
function open(url, { dataRoot, log = () => {} } = {}) {
  const browser = detect();
  if (!browser) {
    log('no browser found for fallback');
    return null;
  }
  const profile = profileDir(browser, dataRoot);
  try {
    fs.mkdirSync(profile, { recursive: true });
  } catch (err) {
    log(`could not create profile at ${profile}: ${err.message}`);
    return null;
  }

  const args = [...browser.args, ...launchArgs(url, { profile })];
  try {
    const child = spawn(browser.command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    log(`handed off to ${browser.kind} browser: ${url}`);
    return { browser: browser.kind, profile, pid: child.pid };
  } catch (err) {
    log(`launch failed: ${err.message}`);
    return null;
  }
}

module.exports = { detect, profileDir, launchArgs, open, FLATPAK_ID };