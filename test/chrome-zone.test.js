'use strict';

/**
 * The bar's reveal behaviour.
 *
 * Reported as "it appears when my mouse is nowhere near the top". Two causes,
 * both covered here:
 *
 *   - the reveal band was 200px, so a pointer well down the screen counted as
 *     being at the top;
 *   - the site preload reported the top on any scroll or key press, so the bar
 *     came back with the pointer parked in the middle of the page.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'site-pointer-preload.js'), 'utf8');

/** Value of a `const NAME = <number>;` declaration. */
function constant(source, name) {
  const match = source.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(match, `${name} not found`);
  return Number(match[1]);
}

test('the reveal band is a thin strip at the top', () => {
  const reveal = constant(mainSrc, 'REVEAL_ZONE_PX');
  assert.ok(
    reveal <= 60,
    `reveal band is ${reveal}px -- that reaches a long way down the screen`,
  );
});

test('the controls travel far enough to clear the window', () => {
  // The controls are a floating pair now, so this is only a travel distance and
  // no longer has to match a CSS height -- but it must exceed the tallest one,
  // or a sliver of them stays on screen when hidden.
  const travel = constant(mainSrc, 'CHROME_TRAVEL_PX');
  assert.ok(travel >= 45, `travel distance ${travel}px would leave part of the controls visible`);
});

test('hiding needs a wider band than revealing, so the bar cannot flicker', () => {
  assert.ok(constant(mainSrc, 'HIDE_ZONE_PX') > constant(mainSrc, 'REVEAL_ZONE_PX'));
});

test('scrolling and key presses do not reveal the bar', () => {
  // These reported the top unconditionally, so the bar appeared no matter where
  // the pointer was.
  const listeners = preloadSrc.match(/addEventListener\('([a-z]+)'/g) || [];
  assert.deepStrictEqual(
    listeners.sort(),
    ["addEventListener('mousemove'", "addEventListener('touchmove'"],
    'only pointer movement should report a position',
  );
});

test('the preload reports the real pointer height', () => {
  // A hard-coded 0 here is what made the bar appear regardless of the pointer.
  assert.match(preloadSrc, /report\(event\.clientY\)/);
  assert.strictEqual((preloadSrc.match(/report\(0\)/g) || []).length, 1, 'report(0) belongs to the touch fallback only');
});

test('touch still has a way to ask for the bar', () => {
  // Touch has no hover, so removing the scroll/keyboard fallbacks must not
  // leave a touch user with no way back.
  assert.match(preloadSrc, /addEventListener\('touchmove'/);
});
