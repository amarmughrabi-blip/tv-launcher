'use strict';

/**
 * Key-system probe, main-process side.
 *
 * Loads a throwaway hidden renderer that asks Chromium whether the Widevine key
 * system is usable, then disposes of it. Results are cached per site for the
 * lifetime of the process: the key system's availability is a property of the
 * runtime, not of the page, so re-probing on every activation is pure latency.
 */

const path = require('node:path');
const { ipcMain, BrowserWindow } = require('electron');

const PROBE_PAGE = path.join(__dirname, 'key-system-probe.html');
const PROBE_PRELOAD = path.join(__dirname, 'key-system-probe-preload.js');
const PROBE_TIMEOUT_MS = 20_000;

/** @type {Map<string, {ok: boolean, keySystem: string, reason: string|null}>} */
const cache = new Map();

async function runProbeOnce() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener('drm:probe-result', onResult);
      if (!win.isDestroyed()) win.destroy();
      resolve(result);
    };

    const onResult = (_event, result) => finish(result);
    ipcMain.once('drm:probe-result', onResult);

    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          keySystem: 'com.widevine.alpha',
          reason: `probe timed out after ${PROBE_TIMEOUT_MS}ms`,
        }),
      PROBE_TIMEOUT_MS,
    );

    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 120,
      webPreferences: {
        preload: PROBE_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        offscreen: false,
      },
    });

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        ipcMain.removeListener('drm:probe-result', onResult);
        resolve({
          ok: false,
          keySystem: 'com.widevine.alpha',
          reason: 'probe window closed before reporting',
        });
      }
    });

    win.loadFile(PROBE_PAGE).catch((err) =>
      finish({ ok: false, keySystem: 'com.widevine.alpha', reason: String(err) }),
    );
  });
}

/**
 * @param {string} siteId cache key, normally the site URL
 */
async function probe(siteId) {
  if (cache.has(siteId)) return cache.get(siteId);
  const result = await runProbeOnce();
  cache.set(siteId, result);
  return result;
}

function clearCache() {
  cache.clear();
}

module.exports = { probe, clearCache, PROBE_TIMEOUT_MS };