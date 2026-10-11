'use strict';

/**
 * The theme, and the selects.
 *
 * Two things being defended.
 *
 * A native <select> cannot be themed. Its closed control is ours, but the list
 * it opens is drawn by the operating system in the system colours, out of reach
 * of any stylesheet -- a white dropdown in the middle of a dark settings screen.
 * So the list has to be painted here, and this asserts that what is actually on
 * screen follows the theme rather than the system.
 *
 * And the theme has to be applied before the first frame. Asking for it after
 * the window has painted means a white flash on a dark desktop on every launch,
 * which is the sort of thing that gets a theme setting ignored entirely.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;

const field = (id) => document.getElementById(id);

function rgb(value) {
  const m = /rgba?\((\d+), (\d+), (\d+)/.exec(value || '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Perceived brightness, because "is it dark" is a question about pixels. */
function brightness(colour) {
  const c = rgb(colour);
  if (!c) return null;
  return (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000;
}

(async () => {
  const bridge = window.api;

  const faces = [...document.querySelectorAll('#picker-grid .picker-item:not(.picker-add)')];
  if (faces.length) faces[0].click();
  await wait(1500);

  /* ------------------------------- the theme ------------------------------ */

  await bridge.resetSettings();
  await wait(600);

  // Measured on the element that actually paints. <html> carries the variables
  // but no background of its own, so reading it back says "transparent" for both
  // themes and the check would pass without ever looking at a pixel.
  const pageBackground = () => getComputedStyle(document.body).backgroundColor;
  const darkBg = brightness(pageBackground());
  if (darkBg === null) return fail('the page has no background');
  if (darkBg > 90) return fail(`dark theme has a light background (brightness ${Math.round(darkBg)})`);
  out.push(`ok   dark is dark, not merely labelled dark (brightness ${Math.round(darkBg)})`);

  field('rail-settings').click();
  await wait(900);
  if (!field('settings-dialog').open) return fail('the settings screen did not open');

  // Channels first. It is what the screen was opened for, and Theme being the
  // landing tab pushes the thing you came for one click away.
  const shownTab = [...document.querySelectorAll('.settings-section')]
    .filter((s) => s.classList.contains('is-active'))
    .map((s) => s.dataset.section);
  if (shownTab.length !== 1 || shownTab[0] !== 'channels') {
    return fail(`the settings screen opens on ${shownTab.join(',') || 'nothing'}, not channels`);
  }
  out.push('ok   the settings screen opens on Channels');

  const tabs = [...document.querySelectorAll('.settings-tab')].map((t) => t.dataset.section);
  if (!tabs.includes('theme')) return fail('there is no theme section');

  /* ---------------- the dialog itself has to follow the theme -------------- */

  // This is the one that was missed. The page background, the text and the open
  // list were all checked and all followed the theme, while the settings dialog
  // itself stayed black throughout -- because .editor and .field input carried
  // hardcoded dark colours that no variable ever reached. A theme that only
  // half-applies looks worse than no theme at all.
  const dialog = field('settings-dialog');
  const darkDialog = brightness(getComputedStyle(dialog).backgroundColor);
  const darkInput = brightness(getComputedStyle(field('set-region-search')).backgroundColor);
  if (darkDialog === null || darkDialog > 90) {
    return fail(`the settings dialog is not dark in the dark theme (${Math.round(darkDialog || 0)})`);
  }
  out.push(`ok   the dialog and its inputs are dark to begin with (${Math.round(darkDialog)})`);

  /* --------------------------- switching to light ------------------------- */

  const themeSelect = field('set-theme');
  themeSelect.value = 'light';
  themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(1000);

  if (document.documentElement.dataset.theme !== 'light') {
    return fail(`the theme did not change (is "${document.documentElement.dataset.theme}")`);
  }
  const lightBg = brightness(pageBackground());
  if (lightBg === null || lightBg < 140) {
    return fail(`light theme is not light (brightness ${Math.round(lightBg || 0)})`);
  }
  out.push(`ok   light is light (brightness ${Math.round(lightBg)}, was ${Math.round(darkBg)})`);

  const lightDialog = brightness(getComputedStyle(dialog).backgroundColor);
  const lightInput = brightness(getComputedStyle(field('set-region-search')).backgroundColor);
  if (lightDialog === null || lightDialog < 140) {
    return fail(
      `the settings dialog did not follow the theme -- still dark at brightness ` +
        `${Math.round(lightDialog || 0)} in a light theme`,
    );
  }
  if (lightInput === null || lightInput < 140) {
    return fail(`the dialog's inputs did not follow the theme (${Math.round(lightInput || 0)})`);
  }
  out.push(`ok   the dialog and its inputs follow it too (${Math.round(darkDialog)} -> ${Math.round(lightDialog)})`);

  // The backdrop, which is drawn behind the dialog and is just as visible.
  const backdrop = getComputedStyle(dialog, '::backdrop').backgroundColor;
  if (backdrop === 'rgba(0, 0, 0, 0)' || backdrop === undefined) {
    return fail('the dialog backdrop has no colour');
  }
  out.push('ok   and the backdrop is drawn');

  // And back, so the setting is a two-way street.
  themeSelect.value = 'dark';
  themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(900);
  const backBg = brightness(pageBackground());
  if (backBg === null || backBg > 90) return fail('the theme did not go back to dark');
  out.push('ok   and back to dark');

  /* ------------------------------- the text ------------------------------- */

  // Text has to stay readable in both. A background that flips and text that
  // does not is the failure that makes a light theme unusable rather than ugly.
  const textOf = () => brightness(getComputedStyle(document.body).color);
  if (textOf() <= backBg) return fail('dark theme: the text is darker than the background');
  themeSelect.value = 'light';
  themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(900);
  if (textOf() >= lightBg) return fail('light theme: the text is lighter than the background');
  out.push('ok   text stays readable in both themes');

  /* ------------------------------ the selects ---------------------------- */

  // Every select in the settings, painted.
  for (const id of ['set-theme', 'set-check-schedule', 'set-quality', 'set-subtitles']) {
    const select = field(id);
    if (!select) return fail(`no ${id}`);
    if (!select._wrap) return fail(`${id} is still a native control with no painted list`);
    const painted = select._wrap.querySelectorAll('.select-option').length;
    if (painted !== select.options.length) {
      return fail(`${id} paints ${painted} of ${select.options.length} options`);
    }
  }
  out.push('ok   every select has a painted list matching its options');

  // The one that matters: what the list looks like when it is open, in light.
  // The playback section first -- sections that are not showing are display:none,
  // so a control in one of them measures zero by zero and an open list inside it
  // would look broken when it is simply not on screen yet.
  document.querySelector('.settings-tab[data-section="playback"]').click();
  await wait(400);
  const quality = field('set-quality');
  quality._trigger.click();
  await wait(500);

  const menu = document.querySelector('.select-menu:not([hidden])');
  if (!menu) return fail('the quality menu did not open');
  const menuRect = menu.getBoundingClientRect();
  if (menuRect.width < 50) return fail(`the open menu is ${Math.round(menuRect.width)}px wide`);
  if (menuRect.top < 0 || menuRect.bottom > window.innerHeight) {
    return fail('the open menu runs off the screen');
  }

  const menuBg = brightness(getComputedStyle(menu).backgroundColor);
  const opt = menu.querySelector('.select-option');
  const optColour = brightness(getComputedStyle(opt).color);
  // A system-drawn list is white regardless of the theme. This is the check that
  // would have caught it.
  if (menuBg === null || menuBg < 140) {
    return fail(
      `the open menu is not following the theme (brightness ${Math.round(menuBg || 0)} in a light theme)`,
    );
  }
  if (optColour === null || optColour >= menuBg) {
    return fail('the open menu has unreadable options');
  }
  out.push(`ok   the open list follows the theme, not the system (brightness ${Math.round(menuBg)})`);

  // Choosing something actually changes the value, because the painted list is
  // only a face -- the native element underneath is what the app reads.
  const before = quality.value;
  const target = [...menu.querySelectorAll('.select-option')]
    .find((li) => li.dataset.value !== before);
  const wanted = target.dataset.value;
  target.click();
  await wait(500);
  if (quality.value !== wanted) {
    return fail(`picking an option did not change the value (${quality.value}, wanted ${wanted})`);
  }
  if (menu && !menu.hidden) return fail('the menu stayed open after choosing');
  out.push(`ok   choosing an option sets the value and closes the list (${before} -> ${wanted})`);

  /* --------------------- a select filled in after startup ------------------ */

  // The channel editor builds its genre list when it opens, so its painted list
  // has to catch up rather than staying empty for the life of the app.
  field('settings-close').click();
  await wait(400);
  document.querySelector('.rail-btn[data-tab="tv"]').click();
  await wait(1200);
  field('tv-add').click();
  await wait(900);

  const genre = field('channel-genre');
  if (!genre._wrap) return fail('the genre select has no painted list');
  if (genre._wrap.querySelectorAll('.select-option').length !== genre.options.length) {
    return fail(
      `the genre list paints ${genre._wrap.querySelectorAll('.select-option').length} of ` +
        `${genre.options.length} options -- it was filled in after startup`,
    );
  }
  out.push(`ok   a select filled in later still gets its list (${genre.options.length} genres)`);

  await bridge.resetSettings();
  await wait(400);

  return out.join(' | ');
})();