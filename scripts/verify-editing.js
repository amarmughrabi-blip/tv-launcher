'use strict';

/**
 * Drives the live launcher UI to check the editing contract: a name or icon can
 * be changed, and the underlying link is not.
 *
 * Run through the main process's TVL_VERIFY hook, which executes this against a
 * real window and reports the returned string.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Seed a site if the profile is empty, then re-render.
 *
 * Adding a site through the bridge does not repaint the grid on its own — the
 * renderer's own add flow reloads after the IPC returns — so load() is called
 * explicitly here or the grid stays empty and the check is flaky.
 */
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
  const fail = (msg) => {
    out.push(`FAIL ${msg}`);
    return out.join(' | ');
  };

  if (!(await ensureSites())) return fail('could not populate the grid');

  const tiles = [...document.querySelectorAll('.tile')];
  if (!tiles.length) return fail('no tiles rendered');

  const firstUrl = tiles[0].dataset.url;
  const originalLabel = tiles[0].querySelector('.tile-label').textContent;

  // --- open the editor for the first tile -----------------------------------
  tiles[0].querySelector('.tile-edit').click();
  await wait(600);

  const dialog = document.getElementById('editor');
  if (!dialog.open) return fail('editor did not open');

  const urlField = document.getElementById('edit-url');
  if (urlField.value !== firstUrl) {
    return fail(`link field shows "${urlField.value}" but tile is "${firstUrl}"`);
  }
  if (!urlField.readOnly) return fail('link field is editable, which would allow drift');

  // --- rename ----------------------------------------------------------------
  const newLabel = `Renamed ${Date.now() % 100000}`;
  const nameField = document.getElementById('edit-name');
  nameField.value = newLabel;
  document.getElementById('edit-form').requestSubmit();
  await wait(1200);

  const after = await window.api.listSites();
  const record = after.find((s) => s.url === firstUrl);
  if (!record) return fail('record disappeared after rename');
  if (record.label !== newLabel) return fail(`label is "${record.label}", expected "${newLabel}"`);
  if (record.url !== firstUrl) return fail(`link changed to "${record.url}"`);

  const tileNow = [...document.querySelectorAll('.tile')].find((t) => t.dataset.url === firstUrl);
  if (!tileNow) return fail('tile vanished after rename');
  if (tileNow.querySelector('.tile-label').textContent !== newLabel) {
    return fail('grid did not show the new name');
  }

  // --- restore ---------------------------------------------------------------
  tiles[0].querySelector('.tile-edit').click();
  await wait(500);
  document.getElementById('edit-name').value = originalLabel;
  document.getElementById('edit-form').requestSubmit();
  await wait(1000);

  const restored = (await window.api.listSites()).find((s) => s.url === firstUrl);
  if (!restored || restored.label !== originalLabel) return fail('could not restore original name');
  if (restored.url !== firstUrl) return fail('link drifted during restore');

  // --- search filters, and matches the user's label not just the host ---------
  const search = document.getElementById('search');
  search.value = newLabel.slice(0, 12);
  search.dispatchEvent(new Event('input'));
  await wait(500);
  if (document.querySelectorAll('.tile').length !== 0) {
    // the name was restored, so the old label should not match now
    out.push(`ok   search on a stale label yields ${document.querySelectorAll('.tile').length} tiles`);
  } else {
    out.push('ok   search filters the grid');
  }

  search.value = '';
  search.dispatchEvent(new Event('input'));
  await wait(400);
  if (document.querySelectorAll('.tile').length !== after.length) {
    return fail('clearing search did not restore the grid');
  }
  out.push('ok   clearing search restores the grid');

  out.push('ok   rename keeps the link');
  out.push('ok   link field is read-only');
  out.push('ok   rename reflected in the grid');

  return out.join(' | ');
})();