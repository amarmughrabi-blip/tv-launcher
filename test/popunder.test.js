'use strict';

/**
 * The pop-under guard.
 *
 * Pop-under networks rotate domains faster than any filter list updates, so the
 * defence has to be structural rather than list-based. These assert the shape of
 * the injected script; whether it actually works in a page is covered live by
 * scripts/verify-ads.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const { GUARD, BEACON_MAX_PX } = require('../src/popunder-guard');

test('window.open is made inert', () => {
  assert.match(GUARD, /defineProperty\(window,\s*'open'/);
});

test('the page cannot put a working window.open back', () => {
  // Configurable would let a pop-under simply redefine it. This is the whole
  // reason the guard runs in the page's world rather than beside it.
  assert.match(GUARD, /configurable:\s*false/);
});

test('the guard is idempotent', () => {
  // Re-armed on every load; a second injection must not stack observers.
  assert.match(GUARD, /__tvPopunderGuard/);
  assert.match(GUARD, /__tvGuardObserver/);
});

test('re-injection is not a no-op', () => {
  // The first injection lands at document start, where there is no
  // documentElement to observe. Returning early on the second run left the
  // sweep unarmed for the life of the page, and whether the guard worked came
  // down to a race -- which is exactly how it reached a release.
  assert.doesNotMatch(GUARD, /if \(window\.__tvPopunderGuard\) return/);
});

test('the observer is installed on the document, not documentElement', () => {
  // documentElement does not exist yet at document start, so observing it
  // silently armed nothing.
  assert.match(GUARD, /observe\(document,/);
  assert.doesNotMatch(GUARD, /observe\(start/);
  assert.doesNotMatch(GUARD, /document\.documentElement/);
});

test('beacon frames are swept', () => {
  assert.match(GUARD, /querySelectorAll\('iframe, frame, embed'\)/);
  assert.match(GUARD, /MutationObserver/);
});

test('the beacon threshold is small enough to spare a real player', () => {
  // A player is hundreds of pixels across. If this number were raised, video
  // would stop working -- which is a far worse failure than a stray ad.
  assert.ok(BEACON_MAX_PX <= 16, `beacon threshold ${BEACON_MAX_PX}px is too close to player size`);
  assert.match(GUARD, new RegExp(`\\$\\{BEACON_MAX_PX\\}|MAX = ${BEACON_MAX_PX}`));
});

test('the guard is a self-invoking expression, safe to inject twice', () => {
  assert.match(GUARD.trim(), /^\(\(\)\s*=>\s*\{/);
  assert.match(GUARD, /\}\)\(\)$/);
});

test('main arms the guard as well as the preload', () => {
  // The preload is the early hook, but a page that redefines open after load
  // would otherwise get a working one back.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /executeJavaScript\(POPUNDER_GUARD\)/);
});

test('the site preload injects into the page world, not its own', () => {
  // The preload is context-isolated: overriding window.open there would change
  // nothing for the site, and the guard would look armed while doing nothing.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'site-pointer-preload.js'), 'utf8');
  assert.match(src, /webFrame\.executeJavaScript\(POPUNDER_GUARD\)/);
});

test('the preload and the module carry the same guard', () => {
  // A sandboxed preload cannot require a relative file, so the source is
  // duplicated. Requiring it broke the preload outright and silently took the
  // pointer reporting down with it, so the copies are compared here rather than
  // trusted.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'site-pointer-preload.js'), 'utf8');
  const inlined = src.match(/const POPUNDER_GUARD = `([\s\S]*?)`;/);
  assert.ok(inlined, 'the preload no longer inlines the guard');
  assert.strictEqual(inlined[1], GUARD, 'the preload copy has drifted from src/popunder-guard.js');
});

test('the preload does not require relative modules', () => {
  // Sandboxed preloads resolve no relative paths; a stray require throws before
  // any listener is attached and the preload dies without a word.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'site-pointer-preload.js'), 'utf8');
  const relative = [...src.matchAll(/require\('(\.[^']*)'\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(relative, [], `preload requires ${relative.join(', ')}`);
});

test('pop-ups are still denied in the main process', () => {
  // Two independent layers: the guard stops the chain, the handler refuses the
  // request. Either alone would do; both together survive either failing.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /setWindowOpenHandler/);
  assert.match(src, /action:\s*'deny'/);
});
