'use strict';

/*
 * The theme is applied before anything paints.
 *
 * A separate early script because doing it from the settings screen means a
 * white flash on a dark desktop on every launch -- the window paints before
 * anything has had a chance to ask main what the preference is. This one runs
 * first, synchronously, and the flash never happens.
 *
 * Kept separate from app.js rather than added at the top of it so that the
 * browser has nothing to parse, resolve or run between this and the first frame.
 */

(function () {

/**
 * What the desktop is currently using.
 *
 * Read once and cached: `system` has to be resolved to a concrete value at the
 * point it is applied, or a later change to the desktop theme would leave the
 * launcher claiming to follow it while showing the old one.
 */
const query = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null;

let systemIsLight = query ? query.matches : false;
if (query) {
  const onChange = (event) => {
    systemIsLight = event.matches;
    apply(window.__requestedTheme || 'dark');
  };
  if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
  else if (typeof query.addListener === 'function') query.addListener(onChange);
}

/** Resolve a setting to the attribute the stylesheet keys off. */
function resolve(theme) {
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  return systemIsLight ? 'light' : 'dark';
}

/** Put the theme on the document. `system` is stored, so it keeps following. */
function apply(theme) {
  window.__requestedTheme = theme || 'dark';
  document.documentElement.dataset.theme = resolve(theme);
}

// Asked of main here rather than from an inline bootstrap, because the launcher
// has a Content Security Policy without 'unsafe-inline' and an inline script is
// blocked outright. The call is synchronous, so it still lands before the first
// frame -- which is the entire reason for doing it this early.
try {
  if (window.api && typeof window.api.bootTheme === 'function') apply(window.api.bootTheme());
} catch {
  apply('dark');
}

  window.launcherTheme = { apply, resolve };
})();