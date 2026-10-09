'use strict';

/**
 * Phase 1 gate.
 *
 * Answers one question and exits: does this runtime expose a usable Widevine
 * key system? Everything downstream — in-window playback, the launcher, the
 * fallback routing — depends on that answer, so it gets checked on its own
 * before any of it is built.
 *
 *   ./node_modules/electron/dist/electron scripts/drm-gate.js
 */

const { app } = require('electron');
const { waitForCdm } = require('../src/drm');
const { probe } = require('../src/key-system');

const log = (...args) => console.log('[gate]', ...args);

app.whenReady().then(async () => {
  const version = process.versions;
  log(`electron ${version.electron}`);
  log(`chromium ${version.chrome}`);
  log(`node ${version.node}`);
  log('');

  const cdm = await waitForCdm({ log });
  log('');
  log(`CDM ready : ${cdm.available}${cdm.reason ? ` (${cdm.reason})` : ''}`);
  if (!cdm.available) {
    log('');
    log('RESULT: FAIL — component never became ready');
    app.exit(2);
  }

  const keySystem = await probe('gate');
  log(`key system: ${keySystem.keySystem}`);
  log(`usable    : ${keySystem.ok}${keySystem.reason ? ` (${keySystem.reason})` : ''}`);

  log('');
  if (keySystem.ok) {
    log('RESULT: PASS — protected playback is available in-window');
    app.exit(0);
  } else {
    log('RESULT: FAIL — no usable Widevine key system');
    log('');
    log('Check that scripts/setup-ecs.sh completed and that node_modules/electron/dist');
    log('contains the ECS runtime rather than the stock Electron build.');
    app.exit(1);
  }
});

app.on('window-all-closed', () => {});