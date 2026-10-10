'use strict';

/**
 * The pop-under guard.
 *
 * Pop-under networks rotate domains faster than any filter list updates, so the
 * defence has to be structural rather than list-based. These assert the shape of
 * the injected script; whether it works in a page is covered live by
 * scripts/verify-ads.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { GUARD } = require('../src/popunder-guard');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('window.open is made inert', () => {
  assert.match(GUARD, /defineProperty\(window,\s*'open'/);
});

test('the page cannot put a working window.open back', () => {
  // Configurable would let a pop-under simply redefine it. This is the whole
  // reason the guard runs in the page's world rather than beside it.
  assert.match(GUARD, /configurable:\s*false/);
});

test('the guard is a self-invoking expression, safe to inject twice', () => {
  assert.match(GUARD.trim(), /^\(\(\)\s*=>\s*\{/);
  assert.match(GUARD, /\}\)\(\)$/);
});

test('the guard does not sweep DOM nodes', () => {
  // This is the important one. Removing beacon frames on sight looks like a
  // tidy fix and is not: ad scripts re-insert them, and the page ends up in a
  // remove/re-insert loop until the load times out. cinebytv.com stopped
  // rendering entirely under it. The pop-up request is refused by the main
  // process instead, which carries no such risk.
  assert.doesNotMatch(GUARD, /MutationObserver/);
  assert.doesNotMatch(GUARD, /querySelectorAll/);
  assert.doesNotMatch(GUARD, /\.remove\(\)/);
});

test('the guard starts no timers or intervals', () => {
  // A background loop injected into someone else's page is a liability even when
  // it works; nothing here should outlive the call.
  assert.doesNotMatch(GUARD, /setInterval|setTimeout|requestAnimationFrame/);
});

test('main arms the guard as well as the preload', () => {
  // The preload is the early hook, but a page that redefines open after load
  // would otherwise get a working one back.
  assert.match(read('main.js'), /executeJavaScript\(POPUNDER_GUARD\)/);
});

test('the site preload injects into the page world, not its own', () => {
  // The preload is context-isolated: overriding window.open there would change
  // nothing for the site, and the guard would look armed while doing nothing.
  assert.match(read('src/site-pointer-preload.js'), /webFrame\.executeJavaScript\(POPUNDER_GUARD\)/);
});

test('the preload and the module carry the same guard', () => {
  // A sandboxed preload cannot require a relative file, so the source is
  // duplicated. Requiring it broke the preload outright and silently took the
  // pointer reporting down with it, so the copies are compared here rather than
  // trusted.
  const inlined = read('src/site-pointer-preload.js').match(/const POPUNDER_GUARD = `([\s\S]*?)`;/);
  assert.ok(inlined, 'the preload no longer inlines the guard');
  assert.strictEqual(inlined[1], GUARD, 'the preload copy has drifted from src/popunder-guard.js');
});

test('the preload does not require relative modules', () => {
  // Sandboxed preloads resolve no relative paths; a stray require throws before
  // any listener is attached and the preload dies without a word.
  const relative = [...read('src/site-pointer-preload.js').matchAll(/require\('(\.[^']*)'\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(relative, [], `preload requires ${relative.join(', ')}`);
});

test('pop-ups are still denied in the main process', () => {
  // With the DOM sweep gone this is the layer that does the work, so it has to
  // stay.
  const src = read('main.js');
  assert.match(src, /setWindowOpenHandler/);
  assert.match(src, /action:\s*'deny'/);
});
