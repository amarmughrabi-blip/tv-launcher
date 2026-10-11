'use strict';

/**
 * The settings screen, against the real app.
 *
 * Two things are being defended here. First, that a setting actually changes
 * behaviour -- a screen full of controls that save and do nothing is worse than
 * no screen. Second, that the dangerous one is killable: blocking off, and one
 * site excepted, both have to take effect immediately.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;

const field = (id) => document.getElementById(id);

/**
 * Change a control the way a person would.
 *
 * `kind` says which property to set; the event dispatched is always 'change',
 * which is what the screen listens for. Dispatching an event named after the
 * property instead would silently do nothing, which is how a check can pass the
 * first half and fail the second for reasons that have nothing to do with the app.
 */
const changed = async (id, value, kind = 'value') => {
  const el = field(id);
  if (kind === 'checked') el.checked = value;
  else el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(450);
};

(async () => {
  const bridge = window.api;

  const faces = [...document.querySelectorAll('#picker-grid .picker-item:not(.picker-add)')];
  if (faces.length) faces[0].click();
  await wait(1500);

  /* --------------------------- it is reachable --------------------------- */

  const gear = field('rail-settings');
  if (!gear) return fail('there is no settings button');
  const railButtons = [...document.querySelectorAll('.rail-btn')];
  if (railButtons[railButtons.length - 1] !== gear) {
    return fail('the settings button is not at the bottom of the rail');
  }
  out.push('ok   the gear sits at the bottom of the rail');

  // The dialog has to be on screen the instant the button is pressed, not after
  // the settings have been read. It used to load first and show second, so a slow
  // or failing request left the viewer pressing a button that did nothing at all
  // -- which reads as a broken app, and is indistinguishable from one.
  gear.click();
  await wait(60);
  if (!field('settings-dialog').open) {
    return fail('the settings screen is not on screen immediately after the click');
  }

  await wait(900);
  const dialog = field('settings-dialog');
  if (!dialog.open) return fail('the settings screen closed on its own');
  out.push('ok   the menu is up straight away, not after a round trip');

  // Every section has to be reachable, and the one that opens has to be visible
  // rather than merely present -- an element with height 0 is not on screen.
  for (const name of ['channels', 'playback', 'blocking']) {
    const tab = dialog.querySelector(`.settings-tab[data-section="${name}"]`);
    if (!tab) return fail(`no ${name} tab`);
    tab.click();
    await wait(200);
    const section = dialog.querySelector(`.settings-section[data-section="${name}"]`);
    const shown = [...document.querySelectorAll('.settings-section')]
      .filter((s) => s.classList.contains('is-active'));
    if (shown.length !== 1 || shown[0].dataset.section !== name) {
      return fail(`opening ${name} did not show only ${name}`);
    }
    const h = section.getBoundingClientRect().height;
    if (h < 40) return fail(`the ${name} section is ${Math.round(h)}px tall -- present but not drawn`);
  }
  out.push('ok   all three sections open, and are actually drawn');

  /* ------------------------------ defaults ------------------------------ */

  await bridge.resetSettings();
  await wait(500);
  dialog.querySelector('.settings-tab[data-section="channels"]').click();
  await wait(300);

  if (field('set-dead-days').value !== '7') {
    return fail(`the default is ${field('set-dead-days').value} days, not 7`);
  }
  if (field('set-check-schedule').value !== 'never') {
    return fail('the default is not to check on your own');
  }
  if (field('set-subtitles').value !== 'off') return fail('subtitles default on');
  out.push('ok   the defaults are the ones that were argued for');

  /* ------------------------------ genres -------------------------------- */

  const genreChips = [...document.querySelectorAll('#settings-genres .chip')];
  if (!genreChips.length) return fail('no genre chips to choose from');

  // Whichever genre the strip is showing, so the check works against whatever
  // data it is given rather than one hard-coded name that may not be imported.
  document.querySelector('.rail-btn[data-tab="tv"]').click();
  await wait(1200);
  const before = [...document.querySelectorAll('.tv-genre')].map((g) => g.dataset.genre)
    .filter((g) => g !== 'all');
  if (!before.length) return fail('the genre strip is empty');
  const pick = before[before.length - 1];
  const target = genreChips.find((c) => c.textContent.toLowerCase().startsWith(`${pick} `));
  if (!target) return fail(`no chip for the "${pick}" genre that is on the page`);

  dialog.showModal();
  await wait(200);
  target.click();
  await wait(900);

  const after = [...document.querySelectorAll('.tv-genre')].map((g) => g.dataset.genre);
  if (after.includes(pick)) {
    return fail('hiding a genre left it on the TV page');
  }
  // The grid must agree: a strip that says a genre is gone while its channels
  // are still drawn is worse than not filtering at all.
  const stillThere = [...document.querySelectorAll('.tv-section .row-label')]
    .some((h) => h.textContent.toLowerCase().startsWith(pick));
  if (stillThere) return fail('the genre was removed from the strip but its channels are still drawn');
  out.push(`ok   hiding "${pick}" takes it off the TV page, strip and grid together`);

  // And back on.
  const back = [...document.querySelectorAll('#settings-genres .chip')]
    .find((c) => c.textContent.toLowerCase().startsWith(`${pick} `));
  back.click();
  await wait(900);
  const restored = [...document.querySelectorAll('.tv-genre')].map((g) => g.dataset.genre);
  if (!restored.includes(pick)) return fail('a genre could not be put back');
  out.push('ok   and it can be put back');

  /* ------------------------------ blocking ------------------------------ */

  dialog.querySelector('.settings-tab[data-section="blocking"]').click();
  await wait(300);

  if (!field('set-blocking').checked) return fail('blocking defaults off');
  if (!field('set-cosmetics').checked) return fail('element hiding defaults off');

  const stats = await bridge.debugBlocker();
  if (!stats.ready) return fail('the filter engine is not ready');

  await changed('set-blocking', false, 'checked');
  const off = await bridge.debugBlocker();
  const storedNow = (await bridge.settings()).settings.adBlocking;
  if (off.enabled) return fail(`turning blocking off did not take effect (stored=${storedNow}, checked=${field('set-blocking').checked}, visible=${field('set-blocking').getBoundingClientRect().height > 0})`);
  if (off.blocked !== stats.blocked) {
    return fail('something was still blocked after the master switch was turned off');
  }
  out.push('ok   the master switch stops blocking, and is reported as off');

  await changed('set-blocking', true, 'checked');
  const on = await bridge.debugBlocker();
  if (!on.enabled) return fail('turning blocking back on did not take effect');
  out.push('ok   and it comes back on');

  /* --------------------------- site exceptions -------------------------- */

  await changed('set-exception-input', 'example.com', 'input');
  field('set-exception-add').click();
  await wait(900);

  const chips = [...document.querySelectorAll('#settings-exceptions .chip')];
  if (!chips.some((c) => /example\.com/.test(c.textContent))) {
    return fail('a site could not be excepted');
  }
  // Asked of the blocker itself, through the same path a request takes: counting
  // exemptions would need a page open, and a check that opens none would report
  // zero for a setting that is working.
  const exempt = {};
  for (const host of ['example.com', 'cdn.example.com', 'notexample.com', 'doubleclick.net']) {
    exempt[host] = await bridge.debugExempt(host);
  }
  if (!exempt['example.com']) {
    return fail('the exception is listed but the blocker does not honour it');
  }
  if (!exempt['cdn.example.com']) {
    return fail(`a subdomain should be covered too, and is not: ${JSON.stringify(exempt)}`);
  }
  if (exempt['notexample.com']) {
    return fail('a lookalike host is exempt -- the dot is not being required');
  }
  if (exempt['doubleclick.net']) {
    return fail('an unrelated host is exempt');
  }
  out.push('ok   a site exception is honoured for that host and its subdomains only');

  // Removing it must put the blocking back.
  chips.find((c) => /example\.com/.test(c.textContent)).click();
  await wait(900);
  if (await bridge.debugExempt('example.com')) {
    return fail('removing the exception did not clear it');
  }
  const remaining = [...document.querySelectorAll('#settings-exceptions .chip')];
  if (remaining.length) return fail('the exception chip stayed after removal');
  out.push('ok   and removing it puts the blocking back');

  /* ------------------------------ playback ------------------------------ */

  dialog.querySelector('.settings-tab[data-section="playback"]').click();
  await wait(300);
  await changed('set-quality', '480');
  const q = (await bridge.settings()).settings.maxQuality;
  if (q !== '480') return fail(`the quality cap did not save (got ${q})`);

  await changed('set-mute', false, 'checked');
  const m = (await bridge.settings()).settings.muteOnOpen;
  if (m !== false) return fail('mute on open did not save');

  await bridge.resetSettings();
  await wait(400);
  dialog.close();
  await wait(300);

  return out.join(' | ');
})();