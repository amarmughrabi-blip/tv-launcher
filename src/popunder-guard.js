'use strict';

/**
 * Pop-under guard, injected into the page's own JavaScript world.
 *
 * The launcher already denies pop-ups in the main process, but that is the last
 * line of defence. Pop-under networks are built to survive exactly that kind of
 * refusal, and they rotate domains faster than any filter list updates, so
 * waiting for a blocklist to catch up is not a fix.
 *
 * Two mechanisms are neutralised here, before the page's own scripts run:
 *
 *  - window.open. A pop-under is usually a blank window that is written into
 *    after it opens. Making it inert stops the whole chain rather than just its
 *    last step, and it cannot be undone by the page redefining the property.
 *
 *  - Beacon frames. A hidden 1x1 iframe is how the pop-under code is smuggled
 *    in: it carries no content of its own, only a handle for the parent to push
 *    a document into later. Sweeping them as they appear removes the delivery
 *    mechanism regardless of which network is serving it.
 *
 * Both are deliberately narrow. Real players and embeds are large, so the
 * beacon sweep only touches frames a few pixels across.
 *
 * The same source is inlined in src/site-pointer-preload.js, because a sandboxed
 * preload cannot require a relative file. test/popunder.test.js fails if the two
 * ever drift apart.
 */

/** Size below which an iframe cannot be a player and is treated as a beacon. */
const BEACON_MAX_PX = 8;

/*
 * Plain string, no interpolation: it is duplicated verbatim in the preload so
 * the two can be compared byte for byte.
 */
const GUARD = `(() => {
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

module.exports = { GUARD, BEACON_MAX_PX };
