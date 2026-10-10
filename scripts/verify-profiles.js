'use strict';

/**
 * Drives the live launcher to check profiles: a new profile starts empty,
 * switching shows each profile's own apps, and deleting is refused for the last
 * one.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const chips = () => [...document.querySelectorAll('#profile-chips .chip:not(.chip-add)')];
const labels = () => [...document.querySelectorAll('.tile-label')].map((n) => n.textContent);

async function ensureSites() {
  for (let i = 0; i < 60; i += 1) {
    if (document.querySelector('.tile') || document.querySelector('.chip')) break;
    await wait(150);
  }
  for (let i = 0; i < 40; i += 1) {
    if (chips().length) return true;
    await wait(150);
  }
  return false;
}

(async () => {
  const out = [];
  const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;

  if (!(await ensureSites())) return fail('profile switcher did not render');

  // --- the default profile holds the seeded sites --------------------------
  if (chips().length < 1) return fail('expected at least one profile chip');
  out.push(`ok   ${chips().length} profile chip(s)`);

  const seeded = labels();
  if (!seeded.includes('Example')) return fail(`expected the seeded site, saw ${seeded.join()}`);
  out.push(`ok   active profile shows ${seeded.length} app(s)`);

  // --- create a profile ----------------------------------------------------
  const before = chips().length;
  const nameInput = 'Streaming';
  const originalPrompt = window.prompt;
  window.prompt = () => nameInput;

  document.querySelector('.chip-add').click();
  await wait(1200);

  window.prompt = originalPrompt;

  if (chips().length !== before + 1) return fail('new profile chip was not added');
  if (labels().length !== 0) return fail(`a new profile must be empty, saw ${labels().join()}`);
  const active = document.querySelector('.chip.is-active');
  if (!active || active.textContent.indexOf(nameInput) < 0) return fail('new profile is not active');
  out.push(`ok   created "${nameInput}" and it is active and empty`);

  // --- add to it, then switch away and back --------------------------------
  await bridge.addSite('cinebytv.com', 'Cineby', null);
  await window.load();
  await wait(1200);
  if (!labels().includes('Cineby')) return fail('could not add to the new profile');
  out.push('ok   added an app to the new profile');

  chips()[0].click();
  await wait(1400);
  const back = labels();
  if (!back.includes('Example')) return fail('switching back did not show the first profile');
  if (back.includes('Cineby')) return fail('the other profile leaked into this one');
  out.push('ok   switching shows each profile’s own apps');

  chips()[1].click();
  await wait(1200);
  if (!labels().includes('Cineby') || labels().includes('Example')) {
    return fail('switching to the second profile showed the wrong apps');
  }
  out.push('ok   switching back again restores the second profile');

  // --- rename through the dialog -------------------------------------------
  chips()[1].querySelector('.chip-edit').click();
  await wait(700);
  const dialog = document.getElementById('profile-editor');
  if (!dialog.open) return fail('profile editor did not open');

  document.getElementById('profile-name').value = 'Films';
  document.getElementById('profile-form').requestSubmit();
  await wait(1200);

  const listed = await bridge.listProfiles();
  if (!listed.profiles.some((p) => p.name === 'Films')) return fail('rename did not persist');
  out.push('ok   profile renamed');

  // --- delete is offered while another profile remains, then refused --------
  chips()[0].click();
  await wait(1000);
  chips()[0].querySelector('.chip-edit').click();
  await wait(600);
  const del = document.getElementById('profile-delete');
  if (del.disabled) return fail('delete should be available while two profiles exist');
  document.getElementById('profile-cancel').click();
  await wait(400);

  // Remove the second profile for real, then the guard must engage. The edit
  // affordance only exists on the active chip, so activate it first.
  chips()[1].click();
  await wait(1200);
  const originalConfirm = window.confirm;
  window.confirm = () => true;
  chips()[1].querySelector('.chip-edit').click();
  await wait(700);
  document.getElementById('profile-delete').click();
  await wait(1400);
  window.confirm = originalConfirm;

  if (chips().length !== 1) return fail(`expected one profile left, saw ${chips().length}`);
  out.push('ok   deleting a profile leaves the others');

  chips()[0].querySelector('.chip-edit').click();
  await wait(700);
  if (!document.getElementById('profile-delete').disabled) {
    return fail('delete should be disabled when only one profile is left');
  }
  out.push('ok   the last profile cannot be deleted');
  document.getElementById('profile-cancel').click();
  await wait(300);

  const end = await bridge.listProfiles();
  out.push(`ok   cleanup leaves ${end.profiles.length} profile`);

  return out.join(' | ');
})();