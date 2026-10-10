'use strict';

/**
 * Drives the live launcher to check the web path: a tile opens its site inside
 * the window, the toolbar switches to site mode, and Back returns to the grid.
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
  const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;

  if (!(await ensureSites())) return fail('could not populate the grid');

  const tiles = [...document.querySelectorAll('.tile')];
  if (!tiles.length) return fail('no tiles rendered');

  // Pick a site we control so the assertions do not depend on a third party.
  const target = tiles.find((t) => t.dataset.url.includes('example.com')) || tiles[0];
  const url = target.dataset.url;

  const back = document.getElementById('back');
  const search = document.getElementById('search');
  const add = document.getElementById('add');

  if (!back.hidden) return fail('Back is visible before any site is open');

  // --- open -------------------------------------------------------------------
  target.click();
  await wait(2500);

  if (back.hidden) return fail('Back did not appear after opening a site');
  if (!search.hidden) return fail('search still visible in site mode');
  if (!add.hidden) return fail('Add app still visible in site mode');
  out.push('ok   toolbar switches to site mode');

  // The Brave handoff should be offered: in-window playback cannot work, so the
  // route to a real browser has to be reachable from the open site.
  const brave = document.getElementById('open-brave');
  if (brave.hidden) return fail('Open in Brave not offered on an open site');
  out.push('ok   Open in Brave offered on an open site');

  // --- back -------------------------------------------------------------------
  back.click();
  await wait(1200);

  if (!back.hidden) return fail('Back still visible after returning');
  if (search.hidden) return fail('search did not come back');
  if (!document.querySelectorAll('.tile').length) return fail('grid did not come back');
  out.push('ok   back returns to the grid');

  const titles = [...document.querySelectorAll('.tile-label')].map((n) => n.textContent);
  out.push(`ok   grid holds ${titles.length} tiles`);

  return out.join(' | ');
})();