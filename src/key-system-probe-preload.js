'use strict';

/**
 * Probe preload for the key-system check.
 *
 * `navigator.requestMediaKeySystemAccess` is a renderer API, so the probe has to
 * run inside a renderer. This preload runs the check as soon as it is loaded and
 * reports the outcome to the main process over IPC.
 *
 * The probe asks specifically for a *temporary* session: persistent sessions
 * require Verified Media Path, which is not available on Linux, so a temporary
 * probe is the honest question to ask.
 */

const { contextBridge, ipcRenderer } = require('electron');

const KEY_SYSTEM = 'com.widevine.alpha';

const CONFIG = {
  initDataTypes: ['cenc'],
  sessionTypes: ['temporary'],
  videoCapabilities: [
    { contentType: 'video/mp4; codecs="avc1.42E01E"' },
    { contentType: 'video/mp4; codecs="avc1.4D401E"' },
    { contentType: 'video/mp4; codecs="avc1.640028"' },
    { contentType: 'video/webm; codecs="vp9"' },
  ],
};

async function probe() {
  if (!navigator.requestMediaKeySystemAccess) {
    return { ok: false, keySystem: KEY_SYSTEM, reason: 'API not exposed by this runtime' };
  }
  try {
    await navigator.requestMediaKeySystemAccess(KEY_SYSTEM, CONFIG);
    return { ok: true, keySystem: KEY_SYSTEM, reason: null };
  } catch (err) {
    return {
      ok: false,
      keySystem: KEY_SYSTEM,
      reason: err && err.message ? err.message : String(err),
    };
  }
}

contextBridge.exposeInMainWorld('__drmProbe', probe);

ipcRenderer.send('drm:probe-started');

// Fire immediately; the page has no reason to wait.
probe().then((result) => {
  ipcRenderer.send('drm:probe-result', result);
}).catch((err) => {
  ipcRenderer.send('drm:probe-result', { ok: false, keySystem: KEY_SYSTEM, reason: String(err) });
});