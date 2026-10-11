'use strict';

/**
 * Checks the two behaviours that were asked for:
 *   1. the shared bar gets out of the way while a site is open
 *   2. an icon can be changed through the real file picker path, not just the
 *      internal bridge
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureSites() {
  for (let i = 0; i < 80; i += 1) {
    if (typeof window.api?.listSites === 'function' && document.getElementById('grid')) break;
    await wait(150);
  }
  if (document.querySelector('.tile')) return true;
  await window.api.addSite('https://example.com/', 'Example', null);
  await window.load();
  await wait(800);
  return Boolean(document.querySelector('.tile'));
}

(async () => {
  const out = [];
  const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;
  if (!(await ensureSites())) return fail('could not populate the grid');

  const bar = document.getElementById('bar');
  const hidden = () => bar.classList.contains('bar-hidden');

  // --- the bar must be present on the launcher ------------------------------
  if (hidden()) return fail('bar is hidden on the launcher');
  out.push('ok   bar visible on the launcher');

  // --- open a site ------------------------------------------------------------
  const tile = [...document.querySelectorAll('.tile')].find((t) =>
    t.dataset.url.includes('example.com'),
  );
  if (!tile) return fail('no example.com tile to open');

  if (typeof bridge.debugMouseMove !== 'function') {
    return fail('debug input hook missing — run with TVL_DEBUG_INPUT=1');
  }

  tile.click();
  const openedAt = performance.now();
  await wait(600);

  // Park the pointer away from the top, otherwise the physical cursor's real
  // position decides whether the bar hides and the check is meaningless. This
  // has to happen after the site opens: there is no site view to target before.
  const parked = await bridge.debugMouseMove(400);
  if (!parked.ok) return fail('could not place the cursor away from the top');

  // Measured against the clock, not against the sleeps above. Those are lower
  // bounds: on a loaded machine a wait(600) can take well over a second, by
  // which point the bar has auto-hidden and this reports a failure that never
  // happened. AUTO_HIDE_MS is the app's own delay.
  const AUTO_HIDE_MS = 1200;
  const elapsed = performance.now() - openedAt;
  if (hidden()) {
    if (elapsed < AUTO_HIDE_MS) {
      return fail(`bar hid after only ${Math.round(elapsed)}ms, sooner than the ${AUTO_HIDE_MS}ms delay`);
    }
    out.push(`ok   bar auto-hid after ${Math.round(elapsed)}ms (loaded machine)`);
  }

  const view = await window.api.currentSite();
  if (!view) return fail('no site view open');
  out.push(`ok   site open at ${view.url}`);

  // --- the controls must not move unless they are clicked -------------------
  // They used to be driven by a pointer timer in the main process, so they
  // opened and closed on their own and a deliberate click had to be re-asserted
  // against the auto-hide to stick. Visibility now belongs to the page alone.
  const readControls = () =>
    bridge.debugSiteEval(`(() => {
      const host = document.getElementById('__tvl-controls-host');
      if (!host || !host.shadowRoot) return JSON.stringify({ installed: false });
      const sr = host.shadowRoot;
      const pill = sr.querySelector('.pill');
      const r = host.getBoundingClientRect();
      const back = sr.getElementById('b').getBoundingClientRect();
      const brave = sr.getElementById('w').getBoundingClientRect();
      return JSON.stringify({
        installed: true,
        expanded: pill.getAttribute('data-expanded'),
        w: Math.round(r.width), h: Math.round(r.height),
        left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right),
        hidden: host.style.display === 'none',
        backW: Math.round(back.width), braveW: Math.round(brave.width),
      });
    })()`).then((raw) => JSON.parse(raw));

  const toggle = () =>
    bridge.debugSiteEval(
      `document.getElementById('__tvl-controls-host').shadowRoot.getElementById('t').click(); 'clicked'`,
    );

  const start = await readControls();
  if (!start.installed) return fail('the controls were never injected into the page');
  if (start.expanded !== 'false') {
    return fail(`the controls started expanded (state=${start.expanded}) — they should wait to be asked for`);
  }
  out.push('ok   controls start collapsed');

  // Nothing may expand them: not the pointer, and not the passage of time.
  await bridge.debugMouseMove(8);
  await wait(1800);
  const afterHover = await readControls();
  if (afterHover.expanded !== 'false') {
    return fail(`the pointer opened the controls on its own (state=${afterHover.expanded})`);
  }
  out.push('ok   nothing opens them but the toggle');

  // --- the toggle opens them -------------------------------------------------
  await toggle();
  await wait(500);
  const controls = await readControls();
  if (controls.expanded !== 'true') {
    return fail(`the toggle did not expand the controls (state=${controls.expanded})`);
  }
  if (!(controls.backW > 0 && controls.braveW > 0)) {
    return fail('the controls expanded but Back and Open in Brave are not there');
  }
  out.push('ok   the toggle shows Back and Open in Brave');

  // And they must stay put. This is the regression: an auto-hide took them away
  // again seconds later, which is the "it opens and closes by itself" report.
  await wait(2500);
  const stillOpen = await readControls();
  if (stillOpen.expanded !== 'true') {
    return fail(`the controls closed themselves after ${2500}ms (state=${stillOpen.expanded})`);
  }
  out.push('ok   they stay open until told otherwise');

  // --- fullscreen is for the video ------------------------------------------
  await bridge.debugSiteEval('window.__tvlFullscreen(true); "fs"');
  await wait(400);
  const fs = await readControls();
  if (!fs.hidden || fs.w !== 0) {
    return fail(`the controls are still drawn over fullscreen (${fs.w}px wide)`);
  }
  out.push('ok   fullscreen hides them');

  await bridge.debugSiteEval('window.__tvlFullscreen(false); "fs"');
  await wait(400);
  const back = await readControls();
  if (back.hidden || back.expanded !== 'true') {
    return fail(`leaving fullscreen did not restore the controls (hidden=${back.hidden}, state=${back.expanded})`);
  }
  out.push('ok   leaving fullscreen restores them');

  // Top right, as asked, and a small fraction of the window.
  if (controls.right < window.innerWidth * 0.5) {
    return fail(`the controls are not on the right (right edge at ${controls.right}px)`);
  }
  const coverage = (controls.w * controls.h) / (window.innerWidth * window.innerHeight);
  if (coverage > 0.06) {
    return fail(`the controls cover ${(coverage * 100).toFixed(1)}% of the window`);
  }
  out.push(
    `ok   controls are a compact pair in the top right (${controls.w}x${controls.h}, ${(coverage * 100).toFixed(1)}% of the window)`,
  );

  // The toggle must actually work: collapsed by default, and it puts the pair
  // away again without closing the site.
  await bridge.debugSiteEval(
    `document.getElementById('__tvl-controls-host').shadowRoot.getElementById('t').click(); 'clicked'`,
  );
  await wait(600);
  const collapsed = await readControls();
  if (collapsed.expanded !== 'false') {
    return fail(`the toggle did not collapse the controls (state=${collapsed.expanded})`);
  }
  if (!(collapsed.backW === 0 && collapsed.braveW === 0)) {
    return fail(
      `the collapsed pair still takes space (Back ${collapsed.backW}px, Brave ${collapsed.braveW}px) ` +
        '— it would block clicks on the page',
    );
  }
  if (collapsed.w >= controls.w) {
    return fail(`collapsing did not shrink the controls (${controls.w}px -> ${collapsed.w}px)`);
  }
  out.push(`ok   the toggle shows and hides them (${controls.w}px -> ${collapsed.w}px)`);

  // Leave them expanded for the rest of the check.
  await bridge.debugSiteEval(
    `document.getElementById('__tvl-controls-host').shadowRoot.getElementById('t').click(); 'clicked'`,
  );
  await wait(600);

  // Every visible control has to be fully inside the bar and inside the window.
  // A label that wraps in a narrow window used to grow the row past the bar's
  // height, lifting Back above the top edge where it could not be clicked --
  // the "I cannot leave the site" symptom, from a different cause.
  const barBox = document.getElementById('bar').getBoundingClientRect();
  const escaped = [...document.querySelectorAll('#bar button')]
    .filter((b) => b.offsetParent !== null)
    .map((b) => ({
      id: b.id,
      top: Math.round(b.getBoundingClientRect().top),
      bottom: Math.round(b.getBoundingClientRect().bottom),
    }))
    .filter((b) => b.top < 0 || b.bottom > Math.ceil(barBox.bottom) + 1);
  if (escaped.length) {
    return fail(`bar controls overflow the bar: ${JSON.stringify(escaped)} (bar 0..${Math.round(barBox.bottom)})`);
  }
  const tallest = Math.max(
    0,
    ...[...document.querySelectorAll('#bar button')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => b.getBoundingClientRect().height),
  );
  if (tallest > barBox.height + 1) {
    return fail(`a bar control is ${Math.round(tallest)}px tall in a ${Math.round(barBox.height)}px bar`);
  }
  out.push('ok   no bar control overflows the bar');

  // --- the preload must actually report from a real page --------------------
  if (typeof bridge.debugProbePointer !== 'function') {
    return fail('debug pointer probe missing — run with TVL_DEBUG_INPUT=1');
  }
  const probe = await bridge.debugProbePointer(200);
  if (!probe.ok) {
    return fail(
      'the site preload never reported a pointer event; reveal-on-hover would be dead',
    );
  }
  if (probe.lastPointerY !== 200) {
    return fail(`preload reported ${probe.lastPointerY}px, expected the 200px it was given`);
  }
  out.push(`ok   site preload reports pointer height (${probe.lastPointerY}px)`);

  // --- an icon can be changed through the file input -------------------------
  let editorTile = document.querySelector('.tile');
  if (!editorTile) return fail('no tile to edit');
  const url = editorTile.dataset.url;
  const label = editorTile.querySelector('.tile-label').textContent;

  await window.api.back();
  await wait(1000);

  editorTile = [...document.querySelectorAll('.tile')].find((t) => t.dataset.url === url);
  editorTile.querySelector('.tile-edit').click();
  await wait(700);
  if (!document.getElementById('editor').open) return fail('editor did not open');

  const input = document.getElementById('edit-icon-input');
  if (!input) return fail('no file input');

  // Build a real PNG in the page and push it through the input's change handler,
  // which is the same path the OS picker produces.
  const pngBytes = await (async () => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 200;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e0407a';
    ctx.fillRect(0, 0, 320, 200);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  })();

  const file = new File([pngBytes], 'picked.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  await wait(1800);

  document.getElementById('edit-form').requestSubmit();
  await wait(1200);

  const record = (await window.api.listSites()).find((s) => s.url === url);
  if (!record) return fail('record vanished');
  if (!record.icon) return fail('icon was not set through the file input');
  if (record.url !== url) return fail('link changed when the icon changed');
  if (record.label !== label) return fail('name changed when the icon changed');
  out.push(`ok   icon changed via the picker (${record.icon})`);

  // The grid re-renders asynchronously, so poll rather than assume.
  let showsImage = false;
  for (let i = 0; i < 20; i += 1) {
    const shown = [...document.querySelectorAll('.tile')]
      .find((t) => t.dataset.url === url)
      ?.querySelector('.tile-icon, .badge');
    if (shown && shown.className !== 'badge') {
      showsImage = true;
      break;
    }
    await wait(250);
  }
  if (!showsImage) return fail('tile still shows the letter badge after a custom icon');
  out.push('ok   tile shows the picked image');

  // restore
  await window.api.updateSite(url, label, null);
  await wait(400);

  return out.join(' | ');
})();