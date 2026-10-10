'use strict';

/**
 * The launcher chrome fills the window.
 *
 * The side rail is a column beside the content, and it has to reach the bottom
 * of the window in every state. It did not: the "no apps yet" message was a
 * sibling of the shell rather than a child of the content area, so as a flex
 * item of <body> it took its own height and pushed the rail up, leaving a gap
 * under it that only showed up when there were no apps.
 *
 * This is measured against the real DOM -- the gap is invisible to a check that
 * only asserts the element exists, which is how it survived.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const fail = (why) => {
  console.log(`verify: FAIL ${why}`);
  process.exit(1);
};

/** Enter a freshly created profile, which has no apps. */
async function enterEmptyProfile() {
  const add = document.querySelector('#picker-grid .picker-add');
  if (!add) return fail('no Add Profile tile');
  add.click();
  await wait(600);

  const name = document.getElementById('profile-name');
  if (!name) return fail('no profile name field');
  name.value = 'Empty';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('profile-save').click();
  await wait(1000);

  const items = [...document.querySelectorAll('#picker-grid .picker-item:not(.picker-add)')];
  const last = items[items.length - 1];
  if (!last) return fail('the new profile did not appear in the picker');
  last.click();
  await wait(1800);
  return null;
}

/** Nothing may be laid out below the content area, and it must reach the bottom. */
async function chromeFillsWindow(label) {
  const rail = document.querySelector('.rail');
  const stage = document.querySelector('.stage');
  if (!rail || !stage) return fail('rail or stage missing');

  const railBox = rail.getBoundingClientRect();
  const stageBox = stage.getBoundingClientRect();

  // A pixel of slack for subpixel rounding; anything more is a visible strip.
  const gap = window.innerHeight - railBox.bottom;
  if (gap > 1) {
    return fail(`${label}: ${Math.round(gap)}px gap below the rail (window is ${window.innerHeight}px)`);
  }
  // The rail sits under the shared bar, so it starts one bar-height down -- but
  // it has to reach the window bottom, or the bar's own height is the only
  // thing keeping the layout honest.
  const bar = document.getElementById('bar');
  const barH = bar ? bar.getBoundingClientRect().height : 0;
  if (Math.abs(railBox.top - barH) > 1) {
    return fail(`${label}: rail starts at ${Math.round(railBox.top)}px, expected just under the ${Math.round(barH)}px bar`);
  }
  // The rail and the content must be the same height, or one of them is short.
  if (Math.abs(railBox.height - stageBox.height) > 1) {
    return fail(
      `${label}: rail is ${Math.round(railBox.height)}px but the content area is ${Math.round(stageBox.height)}px`,
    );
  }
  return null;
}

(async () => {
  // --- with apps -------------------------------------------------------------
  const faces = [...document.querySelectorAll('#picker-grid .picker-item:not(.picker-add)')];
  if (faces.length) faces[0].click();
  await wait(1600);
  if (document.querySelectorAll('.tile').length === 0) return fail('the seeded profile has no apps');
  const withApps = await chromeFillsWindow('with apps');
  if (withApps) return withApps;
  out.push('ok   rail fills the window with apps');

  // --- with no apps ----------------------------------------------------------
  // The gap only appeared in this state, which is why it went unnoticed.
  await window.api.back();
  await wait(1200);
  const empty = await enterEmptyProfile();
  if (empty) return empty;
  if (document.querySelectorAll('.tile').length !== 0) return fail('the new profile is not empty');

  const emptyMsg = document.getElementById('empty');
  if (!emptyMsg || emptyMsg.hidden) return fail('the empty-state message is not shown');
  if (!emptyMsg.closest('.stage')) {
    return fail('the empty-state message is outside the content area, so it steals layout height');
  }

  const noApps = await chromeFillsWindow('with no apps');
  if (noApps) return noApps;
  out.push('ok   rail fills the window with no apps');
  out.push('ok   empty-state message sits inside the content area');

  console.log(`verify: ${out.join(' | ')}`);
  return 'ok';
})();
