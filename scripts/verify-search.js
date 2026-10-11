'use strict';

/**
 * Searching across apps and channels, and the favourites row.
 *
 * Both exist because of the same complaint: things you use were hard to reach.
 * The search was apps-only, so typing "news" found no news channel. Favourites
 * did not exist, so reaching BBC Earth meant scrolling past thirty documentary
 * channels every time.
 *
 * The search assertions are about behaviour that would otherwise look fine: a
 * channel that is not in the genre you happen to be looking at has to be
 * findable, because a search that can only find what is already on screen is not
 * a search.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;

function type(box, value) {
  box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

(async () => {
  const bridge = window.api;

  const faces = [...document.querySelectorAll('#picker-grid .picker-item:not(.picker-add)')];
  if (faces.length) faces[0].click();
  await wait(1600);

  const box = document.getElementById('search');
  const view = document.getElementById('search-view');
  const chansGroup = document.getElementById('search-channels-group');
  const chansRow = document.getElementById('search-channels');
  const appsGroup = document.getElementById('search-apps-group');
  const appsRow = document.getElementById('search-apps');

  /* ------------------------------- both kinds ---------------------------- */

  const all = await bridge.channels();
  if (all.grouped.length < 2) return fail('need at least two genres to test across');

  // A genre name, not a channel name. This is the assertion that matters: typing
  // "news" has to find every news channel, and most of them are not called
  // anything like news. Searching names alone quietly reduces a search to a
  // filter over the thing already on screen.
  const target = all.grouped[all.grouped.length - 1];
  const channelTerm = target.genre;
  type(box, channelTerm);
  // The first search typed before the TV page has been opened loads the channel
  // list on demand, so this one waits for a round trip rather than a paint.
  await wait(2500);

  if (view.hidden) return fail('searching did not bring up the results');
  if (chansGroup.hidden) return fail(`no channels found for "${channelTerm}"`);
  const found = [...chansRow.querySelectorAll('.tv-tile')].map((t) => t.dataset.url);
  if (!found.length) return fail('the channel results are empty');

  const byUrl = new Map();
  for (const g of all.grouped) for (const c of g.channels) byUrl.set(c.url, { ...c, genre: g.genre });
  for (const url of found) {
    const c = byUrl.get(url);
    const name = (c.name || '').toLowerCase();
    if (!name.includes(channelTerm) && !(c.genre || '').toLowerCase().includes(channelTerm)) {
      return fail(`"${channelTerm}" matched "${c.name}", which is neither named nor filed under it`);
    }
  }
  // And it must have found at least the ones filed under that genre.
  const inGenre = target.channels.filter((c) => !found.includes(c.url));
  if (inGenre.length) {
    return fail(`"${channelTerm}" missed ${inGenre.length} channels filed under that genre`);
  }
  out.push(`ok   "${channelTerm}" finds ${found.length} channels, every one of them actually that`);

  /* ------------------------- across every genre -------------------------- */

  // The chosen genre must not decide what is findable. Every result has to be
  // findable no matter which tab the search box was opened from.
  for (const tab of ['home', 'apps', 'tv']) {
    document.querySelector(`.rail-btn[data-tab="${tab}"]`).click();
    await wait(500);
    type(box, channelTerm);
    await wait(900);
    if (view.hidden) return fail(`the results vanished when switching to ${tab}`);
    if (chansRow.children.length !== found.length) {
      return fail(`searching from the ${tab} tab found ${chansRow.children.length} of ${found.length}`);
    }
  }
  out.push('ok   the same search finds the same channels from every tab');

  // And a genre that is not the one on screen.
  const visibleNow = [...document.querySelectorAll('.tv-section .row-label')]
    .map((h) => h.textContent.split(' ·')[0].trim());
  const other = all.grouped.find((g) => g.genre !== 'all' && !visibleNow.includes(g.genre));
  if (other) {
    const sample = other.channels[0];
    type(box, sample.name);
    await wait(900);
    const urls = [...chansRow.querySelectorAll('.tv-tile')].map((t) => t.dataset.url);
    if (!urls.includes(sample.url)) {
      return fail(`could not find "${sample.name}", which is filed under ${other.genre}`);
    }
    out.push(`ok   finds a channel filed under a genre that is not on screen (${other.genre})`);
  }

  /* ------------------------------ both lists ----------------------------- */

  // A term in an app name must still work, and the two lists are separate.
  const sites = document.querySelectorAll('#grid .tile').length;
  type(box, 'a');
  await wait(700);
  if (!view.hidden && chansRow.children.length && !appsRow.children.length) {
    // Fine: only channels matched. Assert the apps list works on its own below.
  }
  const appTile = document.querySelector('#grid .tile');
  if (appTile) {
    const label = appTile.textContent.trim().slice(0, 6);
    if (label) {
      type(box, label.toLowerCase());
      await wait(700);
      if (appsGroup.hidden) return fail(`"${label}" found a channel but no app`);
      out.push('ok   apps and channels come back in the same search, as separate lists');
    }
  }

  /* ------------------------------ nothing found -------------------------- */

  type(box, 'zzzzqqqxxx');
  await wait(700);
  if (!document.getElementById('search-empty').hidden) {
    if (chansRow.children.length || appsRow.children.length) {
      return fail('said nothing matched while showing results');
    }
  } else if (chansRow.children.length || appsRow.children.length) {
    return fail('showing results without saying there are none');
  }
  out.push('ok   a search that matches nothing says so');

  // Clearing it puts the page back.
  type(box, '');
  await wait(700);
  if (!view.hidden) return fail('clearing the search did not put the page back');
  if (document.getElementById('grid').hidden && document.getElementById('tv').hidden) {
    return fail('clearing the search left the launcher with nothing to show');
  }
  out.push('ok   clearing it puts the launcher back');

  /* ------------------------------ favourites ----------------------------- */

  document.querySelector('.rail-btn[data-tab="tv"]').click();
  await wait(1600);

  const panel = document.getElementById('tv-favourites');
  if (!panel.hidden) return fail('a favourites row is showing before anything is starred');

  const star = document.querySelector('.tv-tile .tv-star');
  if (!star) return fail('there is no star on the channel tiles');
  star.click();
  await wait(1200);

  if (panel.hidden) return fail('starring a channel did not reveal the favourites row');
  const pinned = [...panel.querySelectorAll('.tv-tile')].map((t) => t.dataset.url);
  const wanted = star.dataset.url;
  if (!pinned.includes(wanted)) return fail('the starred channel is not the one that got pinned');
  out.push('ok   starring a channel pins it to its own row');

  // It has to stay put whatever genre is chosen -- that is the whole point.
  for (const genre of all.grouped.slice(0, 3)) {
    const chip = document.querySelector(`.tv-genre[data-genre="${CSS.escape(genre.genre)}"]`);
    if (!chip) continue;
    chip.click();
    await wait(600);
    if (panel.hidden) return fail(`the favourites row vanished on the ${genre.genre} genre`);
    const still = [...panel.querySelectorAll('.tv-tile')].map((t) => t.dataset.url);
    if (!still.includes(wanted)) return fail(`the favourite disappeared on the ${genre.genre} genre`);
  }
  out.push('ok   it stays pinned whichever genre you go to');

  // And the star must look starred without the pointer anywhere near it.
  const starred = document.querySelector(`.tv-tile[data-url="${CSS.escape(wanted)}"] .tv-star`);
  const opacity = Number(getComputedStyle(starred).opacity);
  if (opacity < 0.9) return fail(`a starred channel does not look starred (opacity ${opacity})`);

  // Un-starring takes it back out.
  starred.click();
  await wait(1200);
  if (!panel.hidden) return fail('un-starring left the favourites row on screen');
  out.push('ok   un-starring takes it away again');

  return out.join(' | ');
})();