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

  // --- open a site; the bar should hide on its own ---------------------------
  const tile = [...document.querySelectorAll('.tile')].find((t) =>
    t.dataset.url.includes('example.com'),
  );
  if (!tile) return fail('no example.com tile to open');

  tile.click();
  await wait(1200);
  if (hidden()) return fail('bar hid immediately instead of staying reachable at first');

  // Past the auto-hide delay it should be gone.
  await wait(3000);
  if (!hidden()) return fail('bar did not auto-hide over the site');
  out.push('ok   bar auto-hides over a site');

  const view = await window.api.currentSite();
  if (!view) return fail('no site view open');
  out.push(`ok   site open at ${view.url}`);

  // --- moving the pointer near the top brings it back ------------------------
  document.dispatchEvent(new MouseEvent('mousemove', { clientY: 10, clientX: 400 }));
  await wait(500);
  if (hidden()) return fail('pointer near the top did not restore the bar');
  out.push('ok   bar returns on pointer movement');

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

  const shown = [...document.querySelectorAll('.tile')]
    .find((t) => t.dataset.url === url)
    ?.querySelector('.tile-icon, .badge');
  if (shown && shown.className === 'badge') {
    return fail('tile still shows the letter badge after a custom icon');
  }
  out.push('ok   tile shows the picked image');

  // restore
  await window.api.updateSite(url, label, null);
  await wait(400);

  return out.join(' | ');
})();