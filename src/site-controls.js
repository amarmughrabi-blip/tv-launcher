'use strict';

/**
 * The controls shown over a loaded site.
 *
 * These have to sit *above* the page, which the launcher's own bar cannot do: a
 * WebContentsView added as a child of the window always paints above the
 * window's page, so anything drawn there is behind the site. Leaving a strip
 * uncovered works, but that is the banner and the push-down the user asked to
 * be rid of.
 *
 * So the controls are injected into the page instead, in a shadow root so the
 * site's own CSS cannot reach them. They cost nothing while hidden, take no
 * space in the layout, and never move the page.
 *
 * The page is untrusted, so the host element is re-attached if it removes it,
 * and the host itself is pointer-transparent so only the controls take clicks.
 * Everything inside lives in the shadow root.
 *
 * Clicking is reported through a CustomEvent on `document`, which the site's
 * preload listens for and forwards. Injected script runs in the page's world and
 * has no access to ipcRenderer, so this is the bridge.
 *
 * Injected by the main process, which is also what tells it to show or hide.
 */

const CONTROLS_SCRIPT = `(() => {
  if (window.__tvlControlsInstalled) {
    if (window.__tvlSetControls) window.__tvlSetControls(window.__tvlControlsState || false);
    return 'already';
  }

  const HOST_ID = '__tvl-controls-host';
  let host = null;
  let expanded = false;

  const emit = (action) => {
    try {
      document.dispatchEvent(new CustomEvent('tvl-control', { detail: { action } }));
    } catch (e) {}
  };

  const ICON_BACK = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
  const ICON_WINDOW =
    '<svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="16" rx="2.5"/>' +
    '<path d="M2.5 9h19"/><path d="M6 6.5h.01M9 6.5h.01"/></svg>';
  const ICON_UP = '<svg viewBox="0 0 24 24"><path d="M6 14l6-6 6 6"/></svg>';
  const ICON_DOWN = '<svg viewBox="0 0 24 24"><path d="M6 10l6 6 6-6"/></svg>';

  const build = () => {
    host = document.createElement('div');
    host.id = HOST_ID;
    // The all:initial reset goes first, because it resets every property and
    // would wipe anything set before it. The site's stylesheets cannot reach
    // the shadow root, but they can reach this host, so its own box is pinned
    // inline and important.
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('top', '10px', 'important');
    host.style.setProperty('right', '14px', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    // Transparent, so only the pill takes clicks and the page underneath is
    // never blocked by an invisible box.
    host.style.setProperty('pointer-events', 'none', 'important');
    host.style.setProperty('font-family', 'system-ui, sans-serif', 'important');

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = \`
      <style>
        :host { all: initial; }
        .pill {
          pointer-events: auto;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px;
          border-radius: 999px;
          background: rgba(8, 10, 14, 0.88);
          border: 1px solid rgba(255, 255, 255, 0.12);
          box-shadow: 0 8px 26px rgba(0, 0, 0, 0.55);
          backdrop-filter: blur(10px);
        }
        button {
          all: unset;
          pointer-events: auto;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 28px;
          padding: 0 10px;
          border-radius: 999px;
          color: #e8eaf0;
          font: 500 13px/1 system-ui, sans-serif;
          white-space: nowrap;
        }
        button:hover, button:focus-visible { background: rgba(255, 255, 255, 0.1); }
        button.icon { padding: 0 7px; }
        button svg {
          width: 16px; height: 16px; fill: none; stroke: currentColor;
          stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round;
        }
        .sep { width: 1px; height: 18px; background: rgba(255,255,255,0.14); }
        /* Collapsed: only the toggle. The pair is display:none, not hidden by
           opacity, so it can never intercept a click on the page beneath. */
        .pair { display: inline-flex; align-items: center; gap: 4px; }
        .pill[data-expanded="false"] .pair { display: none; }
        .pill[data-expanded="true"] .toggle svg { transform: rotate(180deg); }
      </style>
      <div class="pill" data-expanded="false" part="pill">
        <button class="toggle icon" id="t" title="Show controls" aria-label="Show controls"
                aria-expanded="false">\${ICON_DOWN}</button>
        <span class="pair">
          <button class="back" id="b" title="Back to the launcher">\${ICON_BACK}Back</button>
          <button class="icon brave" id="w" title="Open in Brave" aria-label="Open in Brave">\${ICON_WINDOW}</button>
        </span>
      </div>
    \`;

    const q = (id) => root.getElementById(id);
    q('t').addEventListener('click', (e) => { e.stopPropagation(); emit('toggle'); });
    q('b').addEventListener('click', (e) => { e.stopPropagation(); emit('back'); });
    q('w').addEventListener('click', (e) => { e.stopPropagation(); emit('brave'); });
    // A click anywhere else on the page means the user is done with the pair.
    root.addEventListener('focusout', () => {});
    return host;
  };

  const attach = () => {
    if (host && host.isConnected) return;
    host = build();
    (document.body || document.documentElement).appendChild(host);
  };

  attach();

  // The site can remove anything in its own DOM, including this.
  try {
    new MutationObserver(() => {
      if (!host || !host.isConnected) attach();
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  window.__tvlSetControls = (open) => {
    expanded = Boolean(open);
    const pill = host && host.shadowRoot && host.shadowRoot.querySelector('.pill');
    if (!pill) return;
    pill.setAttribute('data-expanded', expanded ? 'true' : 'false');
    const toggle = host.shadowRoot.getElementById('t');
    if (toggle) {
      toggle.innerHTML = expanded ? ICON_UP : ICON_DOWN;
      toggle.title = expanded ? 'Hide controls' : 'Show controls';
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
  };

  window.__tvlControlsState = expanded;
  try {
    Object.defineProperty(window, '__tvlControlsInstalled', { value: true, configurable: true });
  } catch (e) {}

  return 'installed';
})()`;

module.exports = { CONTROLS_SCRIPT };
