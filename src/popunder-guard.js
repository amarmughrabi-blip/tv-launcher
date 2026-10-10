'use strict';

/**
 * Pop-under guard, injected into the page's own JavaScript world.
 *
 * The launcher already denies pop-ups in the main process. That is the last
 * line of defence, and on its own pop-under networks are built to shrug it off,
 * so the chain is also broken at the source: window.open is made inert inside
 * the page, non-configurably, before the page's own scripts run.
 *
 * What this deliberately does NOT do is sweep beacon frames.
 *
 * A hidden 1x1 iframe is how pop-under code is smuggled in, and removing it on
 * sight looks like a tidy structural fix. It is not. Ad scripts re-insert the
 * frame, the sweep removes it again, and the page spends its time in a
 * remove/re-insert loop until the load times out -- cinebytv.com stopped
 * rendering entirely under it (ERR_FAILED, 97 images down to none). The cost
 * was measured and the benefit was never demonstrated, so the sweep is gone.
 *
 * Pop-up *requests* are still refused by the main process, which is the layer
 * that actually matters and carries no such risk.
 *
 * The same source is inlined in src/site-pointer-preload.js, because a sandboxed
 * preload cannot require a relative file. test/popunder.test.js fails if the two
 * ever drift apart.
 */

const GUARD = `(() => {
  // Re-injection is harmless and must stay effective: the main process re-arms
  // this after load in case the page redefined window.open in between.
  try {
    Object.defineProperty(window, 'open', {
      value: function () { return null; },
      writable: false,
      configurable: false,
    });
  } catch (e) {
    // Already non-configurable, which is the state we want.
  }

  return 'armed';
})()`;

module.exports = { GUARD };
