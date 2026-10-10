'use strict';

/**
 * Reports pointer height from inside a loaded site.
 *
 * The launcher page cannot do this: while the bar is hidden the site view
 * covers the entire window, so the launcher receives no pointer events. Asking
 * Electron's `screen.getCursorScreenPoint()` is no better — on this Wayland
 * session it reports (0, 0) permanently, verified directly.
 *
 * This preload listens on the DOM in the isolated world and reports only the
 * vertical position. The page cannot observe the listener, and nothing about
 * the site is read beyond where the pointer is.
 */

const { ipcRenderer, webFrame } = require('electron');

/**
 * The pop-under guard, duplicated verbatim from src/popunder-guard.js.
 *
 * A sandboxed preload cannot require a relative file -- doing so killed this
 * preload outright, silently taking the pointer reporting with it. The copy is
 * checked against the module by test/popunder.test.js so the two cannot drift.
 */
const POPUNDER_GUARD = `(() => {
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

/**
 * Arm the pop-under guard before the page's own scripts run.
 *
 * This preload is the earliest hook available on a site's frame, and it must be
 * early: a pop-under that has already opened its window cannot be un-opened.
 * webFrame.executeJavaScript runs in the page's main world, which is the only
 * place overriding window.open has any effect -- this preload itself is
 * isolated, so its own window is not the page's window.
 */
try {
  webFrame.executeJavaScript(POPUNDER_GUARD);
} catch {
  /* the main process re-arms it once the page has loaded */
}

/** Coarse reporting is plenty; sending every move is pure overhead. */
const THRESHOLD_PX = 2;

let lastSent = -999;

function report(y) {
  if (Math.abs(y - lastSent) < THRESHOLD_PX) return;
  lastSent = y;
  ipcRenderer.send('site:pointer', { y });
}

window.addEventListener('mousemove', (event) => report(event.clientY), { passive: true });

// Touch has no hover, so a drag is the only way to ask for the bar. Reported as
// the top because there is no pointer position to report.
window.addEventListener('touchmove', (event) => {
  const touch = event.touches && event.touches[0];
  if (touch) report(0);
}, { passive: true });

// Scrolling and key presses deliberately do NOT reveal the bar. Reporting the
// top for them made it appear with the pointer parked in the middle of the
// screen, which is exactly the "it shows up when I am nowhere near the top"
// behaviour. Escape still works for leaving a site, which is the case those
// listeners were standing in for.