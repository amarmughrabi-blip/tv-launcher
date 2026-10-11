'use strict';

/**
 * Live TV.
 *
 * Three things have to hold, and each has its own way of failing quietly:
 *
 *  - The grid has to be the TV grid. It once rendered 453 app tiles instead,
 *    because tv.js and app.js share one global scope in a classic script and
 *    app.js's buildTile had overwritten this file's.
 *  - A channel has to actually play. Streams are proxied through main because
 *    broadcast CDNs send no CORS headers, so this exercises that path rather
 *    than trusting that it exists.
 *  - 'playing' is not proof of video. hls.js will fire it on a source that has
 *    attached and nothing more, so pixels are sampled too.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;

(async () => {
  const bridge = window.api;

  const faces = [...document.querySelectorAll('#picker-grid .picker-item:not(.picker-add)')];
  if (faces.length) faces[0].click();
  await wait(1800);

  // --- the rail has a TV button, and it is a real control --------------------
  const tvButton = document.querySelector('.rail-btn[data-tab="tv"]');
  if (!tvButton) return fail('no TV button in the rail');
  const order = [...document.querySelectorAll('.rail-btn[data-tab]')].map((b) => b.dataset.tab);
  const homeAt = order.indexOf('home');
  const tvAt = order.indexOf('tv');
  if (homeAt === -1 || tvAt === -1) return fail(`unexpected rail order: ${order.join(',')}`);
  out.push('ok   TV sits in the rail beside Home');

  tvButton.click();
  await wait(2500);

  const tvRoot = document.getElementById('tv');
  if (tvRoot.hidden) return fail('the TV section did not open');
  if (!document.getElementById('grid').hidden) {
    return fail('the apps grid is still showing behind the TV grid');
  }

  // --- the grid is the channel grid, not app tiles --------------------------
  const tiles = document.querySelectorAll('.tv-tile');
  if (!tiles.length) return fail('no channel tiles were rendered');
  if (document.querySelectorAll('#tv-grid .tile').length) {
    return fail('app tiles found inside the TV grid -- the renderers have collided again');
  }
  if (tiles[0].tagName !== 'BUTTON') {
    return fail(`tiles are ${tiles[0].tagName}, not buttons -- not keyboard reachable`);
  }
  const genres = document.querySelectorAll('.tv-genre');
  out.push(`ok   ${tiles.length} channels in ${genres.length - 1} genres`);

  // --- picking a genre narrows the grid --------------------------------------
  const news = [...genres].find((g) => g.dataset.genre === 'news');
  if (!news) return fail('no news genre in the strip');
  news.click();
  await wait(700);
  const afterGenre = document.querySelectorAll('.tv-tile').length;
  if (afterGenre >= tiles.length) {
    return fail(`choosing a genre did not narrow the grid (${afterGenre} of ${tiles.length})`);
  }
  out.push(`ok   a genre narrows the grid (${afterGenre} channels)`);

  // --- one channel plays, for real ------------------------------------------
  document.querySelector('.tv-genre[data-genre="all"]').click();
  await wait(600);

  const wanted = [...document.querySelectorAll('.tv-tile')].find(
    (t) => /al jazeera/i.test(t.textContent),
  );
  const target = wanted || document.querySelector('.tv-tile');
  const targetName = target.querySelector('.tv-name').textContent;
  target.click();

  await wait(11000);

  const state = await bridge.debugPlayer();
  if (!state.open) return fail(`clicking ${targetName} did not open a player`);
  if (!state.fullscreen) return fail(`${targetName} did not open full screen`);
  if (state.state.problem) return fail(`${targetName} showed an error: ${state.state.problem}`);
  if (state.state.paused) return fail(`${targetName} is paused`);
  if (!(state.state.w > 0 && state.state.h > 0)) {
    return fail(`${targetName} produced no video (${state.state.w}x${state.state.h})`);
  }

  const pixels = JSON.parse(await bridge.debugPlayerPixels());
  if (!(pixels.nonBlackPct > 20)) {
    return fail(
      `${targetName} reported playing but the picture is black (${pixels.nonBlackPct}% lit)`,
    );
  }

  out.push(
    `ok   ${targetName} plays full screen (${state.state.w}x${state.state.h}, ${pixels.nonBlackPct}% lit)`,
  );

  // --- and it closes --------------------------------------------------------
  await bridge.closePlayer();
  await wait(800);
  if (bridge.debugPlayer) {
    const after = await bridge.debugPlayer();
    if (after.open) return fail('the player did not close');
  }
  out.push('ok   the player closes');

  return out.join(' | ');
})();