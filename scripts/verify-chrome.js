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
  await wait(600);

  // Park the pointer away from the top, otherwise the physical cursor's real
  // position decides whether the bar hides and the check is meaningless. This
  // has to happen after the site opens: there is no site view to target before.
  const parked = await bridge.debugMouseMove(400);
  if (!parked.ok) return fail('could not place the cursor away from the top');

  if (hidden()) return fail('bar hid immediately instead of staying reachable at first');

  // Past the auto-hide delay it should be gone. Bounded, not a fixed sleep.
  let hidBy = 0;
  for (let i = 0; i < 40; i += 1) {
    await wait(150);
    if (hidden()) {
      hidBy = 600 + (i + 1) * 150;
      break;
    }
  }
  if (!hidBy) {
    const state = await bridge.debugChromeState().catch((e) => ({ err: e.message }));
    return fail(`bar did not auto-hide over the site (state ${JSON.stringify(state)})`);
  }
  out.push(`ok   bar auto-hides over a site (after ${hidBy}ms)`);

  const view = await window.api.currentSite();
  if (!view) return fail('no site view open');
  out.push(`ok   site open at ${view.url}`);

  // --- the reveal band must be a band, not the top half of the screen --------
  // Reported from a wide reveal zone, the bar came back while the pointer was
  // still well down the screen, which reads as it appearing at random.
  const tooLow = await bridge.debugMouseMove(120);
  if (!tooLow.ok) return fail('could not place the cursor below the reveal band');
  await wait(500);
  if (!hidden()) {
    return fail('the bar revealed with the pointer 120px down, well short of the top');
  }
  out.push('ok   pointer below the top does not reveal the bar');

  // --- moving the pointer near the top brings it back ------------------------
  const revealed = await bridge.debugMouseMove(10);
  if (!revealed.ok) return fail('could not place the cursor near the top');
  await wait(700);
  const afterMove = await bridge.debugChromeState().catch(() => null);
  if (hidden()) {
    return fail(`pointer near the top did not restore the bar (state ${JSON.stringify(afterMove)})`);
  }
  out.push('ok   bar returns when the pointer nears the top');

  // The bar has to be genuinely on screen, not merely marked visible: the
  // reveal animation drives both the bar's offset and the view's bounds from
  // the main process, and those used to be able to disagree.
  const backTop = Math.round(document.getElementById('back').getBoundingClientRect().top);
  if (!(backTop >= 0 && backTop < 60)) {
    return fail(`Back is not reachable after reveal (top=${backTop}px)`);
  }
  if (!afterMove || afterMove.chromeOffset !== 0 || afterMove.viewTop <= 0) {
    return fail(`geometry did not follow the reveal (${JSON.stringify(afterMove)})`);
  }
  out.push(`ok   Back is on screen and the page made room for it`);

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

  // And it must hide again once the pointer moves away from the top. Bounded
  // rather than tied to the idle constant, since the countdown starts when the
  // bar was revealed, not when the pointer left.
  await bridge.debugMouseMove(400);
  if (hidden()) return fail('bar vanished the instant the pointer left the top');
  let rehid = false;
  for (let i = 0; i < 40; i += 1) {
    await wait(150);
    if (hidden()) {
      rehid = true;
      break;
    }
  }
  if (!rehid) return fail('bar did not hide again after the pointer moved away');
  out.push('ok   bar hides again when the pointer moves away');

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

  // A real pointer at the top reveals the bar; the same pointer further down
  // must not. Both go through the page's own DOM, not the debug shortcut.
  await bridge.debugProbePointer(8);
  await wait(400);
  if (hidden()) return fail('a real pointer at the top did not reveal the bar');
  out.push('ok   a real pointer move reveals the bar');

  for (let i = 0; i < 30 && !hidden(); i += 1) await wait(150);
  if (!hidden()) return fail('the bar did not hide before the mid-page probe');
  await bridge.debugProbePointer(140);
  await wait(400);
  if (!hidden()) return fail('a real pointer at 140px revealed the bar');
  out.push('ok   a real pointer lower down leaves the bar hidden');

  // Scrolling the page must not bring the bar back. It used to report the top
  // on any scroll, so the bar appeared with the pointer nowhere near it.
  await bridge.debugMouseMove(400);
  for (let i = 0; i < 30 && !hidden(); i += 1) await wait(150);
  if (!hidden()) return fail('the bar did not hide before the scroll probe');
  await bridge.debugProbePointer(0, { scroll: true });
  await wait(500);
  if (!hidden()) return fail('scrolling the page revealed the bar');
  out.push('ok   scrolling does not reveal the bar');

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