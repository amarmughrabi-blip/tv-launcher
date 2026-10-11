'use strict';

/**
 * Start-up, and a profile picture surviving being picked.
 *
 * Two unrelated bugs, both of which look like "the app is not working":
 *
 *  - A picked profile picture was accepted and previewed, then dropped. The
 *    store supported avatars throughout; the preload bridge and the main
 *    handler each dropped the argument on the way past.
 *  - Start-up blocks the main process for seconds while the filter lists are
 *    parsed. A window that has stopped responding with no explanation is worse
 *    than one that says what it is doing, so there is a loading screen -- and it
 *    has to be gone by the time the app is usable, including when the page
 *    happens to load after start-up finished.
 *
 * Driven through the real UI, because both bugs lived in the plumbing between
 * layers that each looked correct on their own.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;

// A genuine 8x8 PNG, so the store really decodes it rather than being handed
// something it can wave through.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAJUlEQVR4' +
  'nGNgkLEIKehZceTBHwmTgJyOJQfu/BAx8MloYRhaEgC2hlmBBYaP+AAAAABJRU5ErkJggg==';

const findEdit = () =>
  document.querySelector('#picker-grid .picker-item .picker-tool[title="Edit"]');

(async () => {
  const bridge = window.api;
  const picker = document.getElementById('picker');

  // --- the loading screen must already be gone by the time we can act ---------
  const boot = document.getElementById('boot');
  if (!boot) return fail('there is no loading screen');
  if (!boot.hidden) {
    return fail('the loading screen is still up once the app is running');
  }
  if (getComputedStyle(boot).display !== 'none') {
    return fail(`the loading screen is still painted (display=${getComputedStyle(boot).display})`);
  }
  out.push('ok   the loading screen is gone once the app is ready');

  // It must not be a permanent fixture either: a window that never paints the
  // launcher behind it would look identical to a hung app.
  const nav = await bridge.isAppReady();
  if (!nav) return fail('start-up never reported itself finished');
  out.push('ok   start-up reports itself finished');

  // --- a picked picture has to survive ---------------------------------------
  const faces = [...document.querySelectorAll('#picker-grid .picker-item:not(.picker-add)')];
  if (faces.length) faces[0].click();
  await wait(1800);

  await bridge.back();
  await wait(1500);
  document.getElementById('rail-profiles').click();
  for (let i = 0; i < 40 && picker.hidden; i += 1) await wait(200);
  if (picker.hidden) return fail('the picker did not come back');

  // Manage mode toggles, so ask for the control rather than assuming one click.
  for (let i = 0; i < 40 && !findEdit(); i += 1) {
    const manage = document.getElementById('picker-manage');
    if (manage && !manage.hidden) manage.click();
    await wait(250);
  }
  if (!findEdit()) return fail('no edit control on the profile');

  const before = await bridge.listProfiles();
  const target = before.profiles[0];
  if (!target) return fail('no profile to edit');
  if (target.avatar) return fail(`profile already has a picture (${target.avatar}); nothing to prove`);

  findEdit().click();
  await wait(900);
  if (!document.getElementById('profile-editor').open) return fail('the profile editor did not open');

  const bytes = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], 'avatar.png', { type: 'image/png' }));
  const input = document.getElementById('profile-avatar-input');
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(900);

  const preview = document.getElementById('profile-avatar-preview').getAttribute('src');
  if (!preview || !preview.includes('app-icon://')) {
    return fail(`the picture was not picked up at all (preview src=${preview})`);
  }
  out.push('ok   picking a picture updates the preview');

  document.getElementById('profile-form').requestSubmit();
  await wait(1400);

  const after = await bridge.listProfiles();
  const saved = after.profiles.find((p) => p.id === target.id);
  if (!saved) return fail('the profile disappeared');
  if (!saved.avatar) {
    return fail('the picture was accepted, previewed, and then dropped on save');
  }
  if (String(saved.avatar).includes('null') || String(saved.avatar).includes('undefined')) {
    return fail(`the picture was saved as the string "${saved.avatar}"`);
  }
  out.push(`ok   it is saved on the profile (${saved.avatar})`);

  const reread = await bridge.listProfiles();
  const again = reread.profiles.find((p) => p.id === target.id);
  if (!again || again.avatar !== saved.avatar) {
    return fail(`it did not survive a reload (${JSON.stringify(again && again.avatar)})`);
  }
  out.push('ok   it survives a reload');

  // Clear it again so the check is repeatable and leaves no litter.
  document.getElementById('rail-profiles').click();
  for (let i = 0; i < 40 && picker.hidden; i += 1) await wait(200);
  for (let i = 0; i < 40 && !findEdit(); i += 1) {
    const manage = document.getElementById('picker-manage');
    if (manage && !manage.hidden) manage.click();
    await wait(250);
  }
  if (findEdit()) {
    findEdit().click();
    await wait(800);
    document.getElementById('profile-avatar-clear').click();
    await wait(300);
    document.getElementById('profile-form').requestSubmit();
    await wait(1200);
    const clean = await bridge.listProfiles();
    const c = clean.profiles.find((p) => p.id === target.id);
    if (c && c.avatar) return fail(`cleanup did not clear the picture (${c.avatar})`);
    out.push('ok   clearing it works too');
  }

  return out.join(' | ');
})();