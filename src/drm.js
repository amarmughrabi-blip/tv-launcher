'use strict';

/**
 * Widevine CDM readiness.
 *
 * ECS installs the CDM through Google's component updater. On Linux the first
 * install requires a restart, so the component must be ready *before* any
 * window that will play protected content is created. Calling
 * `components.whenReady()` first is what keeps that race from biting us.
 *
 * This module must be required from the main process. `components` only exists
 * on the ECS runtime; on stock Electron this resolves immediately and
 * `isAvailable()` reports false, which is the correct signal that the drop-in
 * was not installed.
 */

const WAIT_TIMEOUT_MS = 180_000;

/**
 * Wait for the Widevine component to finish installing/updating.
 * Must be called before the first BrowserWindow is created.
 */
async function waitForCdm({ timeoutMs = WAIT_TIMEOUT_MS, log = () => {} } = {}) {
  const components = require('electron').components;

  if (!components || typeof components.whenReady !== 'function') {
    return {
      available: false,
      reason: 'runtime has no components API — ECS drop-in not installed',
    };
  }

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Widevine component not ready after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    log('waiting for Widevine component');
    await Promise.race([components.whenReady(), timeout]);
    return { available: true, reason: null };
  } catch (err) {
    return { available: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Non-throwing probe: is a usable key system exposed? */
async function isAvailable(opts) {
  const result = await waitForCdm(opts);
  return result.available;
}

module.exports = { waitForCdm, isAvailable, WAIT_TIMEOUT_MS };