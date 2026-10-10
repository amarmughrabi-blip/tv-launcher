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