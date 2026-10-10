'use strict';

/**
 * Drives the live launcher through the Netflix-style picker.
 *
 * Everything is driven through the DOM. Nothing stubs window.prompt or
 * window.confirm, because Electron implements neither -- stubbing them once
 * hid a dead new-profile button behind a passing test.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const picker = () => document.getElementById('picker');
const items = () => [...document.querySelectorAll('#picker-grid .picker-item')];
const faces = () => [...document.querySelectorAll('#picker-grid .picker-item')].filter((n) => !n.classList.contains('picker-add'));
const labels = () => [...document.querySelectorAll('.tile-label')].map((n) => n.textContent);
const dialog = () => document.getElementById('profile-editor');

async function waitForPicker() {
  for (let i = 0; i < 80; i += 1) {
    if (!picker().hidden && faces().length) return true;
    await wait(150);
  }
  return false;
}

(async () => {
  const out = [];
  const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;

  if (!(await waitForPicker())) return fail('picker did not appear on launch');

  const start = faces().length;
  out.push(`ok   picker shows ${start} profile(s) on launch`);

  // The add tile sits at the end, as it does on a TV service.
  const add = items()[items().length - 1];
  if (!add.classList.contains('picker-add')) return fail('no Add Profile tile at the end');
  out.push('ok   Add Profile tile is present');

  if (!picker().hidden && picker().getBoundingClientRect().width < 400) {
    return fail('picker is not full screen');
  }
  out.push('ok   picker covers the window');

  // --- create through the picker -------------------------------------------
  add.click();
  await wait(600);
  if (!dialog().open) return fail('Add Profile did not open a dialog');
  if (document.getElementById('profile-title').textContent !== 'Add Profile') {
    return fail('dialog is not in create mode');
  }
  if (!document.getElementById('profile-delete').hidden) {
    return fail('delete should not be offered when creating');
  }
  out.push('ok   Add Profile opens the create dialog');

  document.getElementById('profile-name').value = 'Streaming';
  document.getElementById('profile-form').requestSubmit();
  await wait(1600);

  if (faces().length !== start + 1) return fail('new profile was not added to the picker');
  out.push('ok   profile created from the picker');

  // --- enter it -------------------------------------------------------------
  const created = faces()[faces().length - 1];
  created.click();
  await wait(1600);

  if (!picker().hidden) return fail('picker did not close after choosing a profile');
  if (labels().length !== 0) return fail(`a new profile must be empty, saw ${labels().join()}`);
  out.push('ok   choosing a profile opens it empty');

  // --- profiles stay separate ----------------------------------------------
  await bridge.addSite('cinebytv.com', 'Cineby', null);
  await window.load();
  await wait(1300);
  if (!labels().includes('Cineby')) return fail('could not add to the new profile');

  showPicker();
  await wait(600);
  faces()[0].click();
  await wait(1500);

  const back = labels();
  if (!back.includes('Example')) return fail('switching did not show the first profile');
  if (back.includes('Cineby')) return fail('the other profile leaked into this one');
  out.push('ok   each profile keeps its own apps');

  // --- manage mode offers rename and guarded delete -------------------------
  showPicker({ manage: true });
  await wait(600);
  if (!picker().hidden && document.getElementById('picker-manage').hidden !== false) {
    // Manage hides its own entry button; tools appear on the tiles instead.
  }
  const tools = document.querySelectorAll('#picker-grid .picker-tool');
  if (tools.length !== faces().length * 2) {
    return fail(`expected two tools per profile, saw ${tools.length}`);
  }
  out.push('ok   manage mode adds edit and delete to every profile');

  // Rename via the picker.
  const second = faces()[1];
  second.querySelector('.picker-tool').click();
  await wait(700);
  if (!dialog().open) return fail('edit dialog did not open from the picker');

  document.getElementById('profile-name').value = 'Films';
  document.getElementById('profile-form').requestSubmit();
  await wait(1500);
  if (!faces()[1].textContent.includes('Films')) return fail('rename not reflected in the picker');
  out.push('ok   renamed from the picker');

  // Delete asks first.
  const del = document.querySelectorAll('#picker-grid .picker-tool')[3];
  del.click();
  await wait(400);
  if (!del.classList.contains('is-armed')) return fail('delete did not ask for confirmation');
  if (faces().length !== 2) return fail('one click must not delete anything');
  out.push('ok   delete asks for confirmation first');

  del.click();
  await wait(1600);
  if (faces().length !== 1) return fail(`expected one profile left, saw ${faces().length}`);
  out.push('ok   confirmed delete removes the profile');

  // --- the last profile is protected ---------------------------------------
  showPicker({ manage: true });
  await wait(600);
  const lastDel = document.querySelectorAll('#picker-grid .picker-tool')[1];
  if (!lastDel.disabled) return fail('delete should be disabled for the only profile');
  out.push('ok   the last profile cannot be deleted');

  showPicker({ manage: false });
  await wait(400);
  const end = await bridge.listProfiles();
  out.push(`ok   cleanup leaves ${end.profiles.length} profile`);
  return out.join(' | ');
})();