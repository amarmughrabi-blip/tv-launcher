'use strict';

/**
 * Zoom guards.
 *
 * Chromium stores per-host zoom levels in the profile, so a zoom applied once
 * survives every restart. That is how the launcher ended up rendering at 6x
 * with nothing in the code to explain it. These assertions cover the guard that
 * stops it recurring; the layout checks that would catch a regression live in
 * scripts/verify-chrome.js, which drives the real window.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('the launcher window resets zoom on load', () => {
  assert.match(mainSrc, /did-finish-load/);
  assert.match(mainSrc, /setZoomFactor\(1\)/);
});

test('a persisted zoom level cannot survive a restart', () => {
  // The guard must both correct the current level and stop new ones sticking.
  assert.match(mainSrc, /zoom-changed/);
  assert.match(mainSrc, /setZoomLevel\(0\)/);
});

test('no debug helper is left behind that can change zoom', () => {
  // TVL_CAPTURE_ZOOM is what wrote a 6x level into the real profile. Nothing
  // in the app should be able to set a zoom factor other than the reset.
  const offenders = [...mainSrc.matchAll(/setZoomFactor\(([^)]*)\)/g)]
    .map((m) => m[1].trim())
    .filter((arg) => arg !== '1');
  assert.deepStrictEqual(offenders, [], `unexpected setZoomFactor calls: ${offenders.join(', ')}`);
});

test('no stale zoom override env var is honoured', () => {
  assert.doesNotMatch(mainSrc, /TVL_CAPTURE_ZOOM/);
});
