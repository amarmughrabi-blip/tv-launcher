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

const { ipcRenderer } = require('electron');

/** Coarse reporting is plenty; sending every move is pure overhead. */
const THRESHOLD_PX = 2;

let lastSent = -999;

function report(y) {
  if (Math.abs(y - lastSent) < THRESHOLD_PX) return;
  lastSent = y;
  ipcRenderer.send('site:pointer', { y });
}

window.addEventListener('mousemove', (event) => report(event.clientY), { passive: true });

// A touch drag has no hover, so treat movement as a request to show the bar.
window.addEventListener('touchmove', (event) => {
  const touch = event.touches && event.touches[0];
  if (touch) report(0);
}, { passive: true });

// Scroll gestures usually carry a pointer with them; report the top on any
// input so the bar is reachable without moving the mouse.
for (const type of ['scroll', 'keydown', 'touchstart']) {
  window.addEventListener(type, () => report(0), { passive: true, capture: true });
}