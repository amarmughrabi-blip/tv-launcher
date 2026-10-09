'use strict';

/**
 * Drives the live launcher to check that a name and an icon can be set
 * independently, and that neither disturbs the link.
 *
 * The file picker itself is OS UI and cannot be driven here, so this exercises
 * the editor's actual save path — storeIcon followed by updateSite with the
 * pending icon — which is what the picker resolves to once a file is chosen.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ensure there is something to edit, so this works on a fresh profile. */
async function ensureSites() {
  for (let i = 0; i < 20; i += 1) {
    if (document.querySelector('.tile')) return true;
    await wait(150);
  }
  await window.api.addSite('https://example.com/', 'Example', null);
  await wait(1200);
  return Boolean(document.querySelector('.tile'));
}

(async () => {
  const out = [];
  const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;

  if (!(await ensureSites())) return fail('could not populate the grid');

  const tile = document.querySelector('.tile');
  if (!tile) return fail('no tiles rendered');
  const url = tile.dataset.url;
  const labelBefore = tile.querySelector('.tile-label').textContent;

  // The editor must expose a file input rather than relying only on a dialog,
  // otherwise an icon can never be changed without OS-level automation.
  const input = document.getElementById('edit-icon-input');
  if (!input) return fail('editor has no file input for choosing an icon');
  out.push('ok   editor exposes an icon file input');

  tile.querySelector('.tile-edit').click();
  await wait(600);
  if (!document.getElementById('editor').open) return fail('editor did not open');
  if (document.getElementById('edit-url').value !== url) return fail('link field drifted');
  if (!document.getElementById('edit-url').readOnly) return fail('link field is editable');

  // --- set an icon, leave the name alone -------------------------------------
  // Fixture is produced by scripts/make-fixture.js; it is deliberately larger
  // than the 256px bound so the downscale is exercised.
  const { name } = await bridge.storeIcon('/tmp/tv-launcher-fixture.png');
  if (!name) return fail('storeIcon returned nothing for the fixture PNG');
  out.push(`ok   icon stored as ${name}`);

  await bridge.updateSite(url, labelBefore, name);
  await wait(900);

  let record = (await bridge.listSites()).find((s) => s.url === url);
  if (!record) return fail('record vanished after the icon change');
  if (record.icon !== name) return fail(`icon is "${record.icon}", expected "${name}"`);
  if (record.url !== url) return fail('link changed when the icon changed');
  if (record.label !== labelBefore) return fail('name changed when the icon changed');
  out.push('ok   icon set; name and link untouched');

  // The stored icon must be reachable through the privileged scheme, otherwise
  // the tile would silently fall back to its badge.
  const probe = new Image();
  probe.src = `app-icon://favicon/${name}`;
  await new Promise((r) => {
    probe.onload = r;
    probe.onerror = r;
  });
  if (!probe.complete || probe.naturalWidth === 0) {
    return fail(`icon ${name} is not served over app-icon://`);
  }
  out.push(`ok   icon served at ${probe.naturalWidth}x${probe.naturalHeight}`);

  // --- rename on top of the custom icon, link still intact -------------------
  const renamed = `Renamed ${Date.now() % 100000}`;
  await bridge.updateSite(url, renamed, name);
  await wait(900);

  record = (await bridge.listSites()).find((s) => s.url === url);
  if (!record || record.label !== renamed) return fail('rename did not apply');
  if (record.icon !== name) return fail('rename dropped the custom icon');
  if (record.url !== url) return fail('link changed on rename');
  out.push('ok   rename keeps both the custom icon and the link');

  // --- restore ---------------------------------------------------------------
  await bridge.updateSite(url, labelBefore, null);
  await wait(900);
  record = (await bridge.listSites()).find((s) => s.url === url);
  if (!record || record.label !== labelBefore) return fail('could not restore the name');
  if (record.icon !== null) return fail(`icon is still "${record.icon}" after reset`);
  if (record.url !== url) return fail('link drifted on restore');
  out.push('ok   icon reset to auto, link intact');

  return out.join(' | ');
})();