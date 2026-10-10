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
  // Re-injection must not be a no-op. The first injection happens at document
  // start, when there is no documentElement to observe; a guard that returned
  // early on its second run would leave the beacon sweep permanently unarmed,
  // and whether it worked would come down to a race.
  try {
    Object.defineProperty(window, '__tvPopunderGuard', { value: true, configurable: false });
  } catch (e) { /* already marked */ }

  try {
    Object.defineProperty(window, 'open', {
      value: function () { return null; },
      writable: false,
      configurable: false,
    });
  } catch (e) { window.open = function () { return null; }; }

  const MAX = 8;
  const sweep = () => {
    let frames;
    try { frames = document.querySelectorAll('iframe, frame, embed'); } catch (e) { return 0; }
    let removed = 0;
    for (const el of frames) {
      let w = 0;
      let h = 0;
      try {
        const r = el.getBoundingClientRect();
        w = Math.max(w, r.width, el.width || 0);
        h = Math.max(h, r.height, el.height || 0);
      } catch (e) { continue; }
      if (w > MAX || h > MAX) continue;
      try { el.remove(); removed += 1; } catch (e) {}
    }
    return removed;
  };

  // Observed on the Document rather than documentElement: at document start the
  // element does not exist yet, and skipping the observer left beacons free to
  // arrive for the rest of the page's life.
  if (!window.__tvGuardObserver) {
    try {
      const obs = new MutationObserver(() => sweep());
      obs.observe(document, { childList: true, subtree: true });
      Object.defineProperty(window, '__tvGuardObserver', { value: obs, configurable: true });
    } catch (e) {}
  }

  sweep();
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