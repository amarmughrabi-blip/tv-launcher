'use strict';

/**
 * Managing channels: adding, filing, hiding, putting back, and checking.
 *
 * The rule being defended throughout is that nothing is ever destroyed by the
 * app on its own initiative. An import keeps what was added by hand, a check
 * shows before it hides, and hiding is free to undo.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;

const added = 'https://verify.test/hand-added.m3u8';

function fill(id, value) {
  const field = document.getElementById(id);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

(async () => {
  const bridge = window.api;

  const faces = [...document.querySelectorAll('#picker-grid .picker-item:not(.picker-add)')];
  if (faces.length) faces[0].click();
  await wait(1500);

  document.querySelector('.rail-btn[data-tab="tv"]').click();
  await wait(2000);

  /* ------------------------------ the toolbar ----------------------------- */

  // Adding a channel is the header button on the TV page; checking them is a
  // settings job now, so the TV page should not be offering either of its own.
  const addBtn = document.getElementById('add');
  if (!addBtn) return fail('no header button on the TV page');
  if (addBtn.textContent.trim() !== 'Add channel') {
    return fail(`the header button says "${addBtn.textContent.trim()}" over a grid of channels`);
  }
  if (document.getElementById('tv-sweep') || document.getElementById('tv-add')) {
    return fail('the TV page still carries its own channel buttons');
  }
  out.push('ok   Add channel replaces Add app on the TV page, and Check lives in Settings');

  /* ------------------------------- adding --------------------------------- */

  addBtn.click();
  await wait(400);
  const dialog = document.getElementById('channel-editor');
  if (!dialog.open) return fail('the add dialog did not open');

  fill('channel-name', 'Hand Added');
  fill('channel-url', added);
  fill('channel-country', 'gb');
  fill('channel-res', '1280x720');

  const genreAtAdd = document.getElementById('channel-genre').value;
  if (!/new channel/i.test(genreAtAdd)) {
    return fail(`a channel added by hand did not start in the new-channel pile (got "${genreAtAdd}")`);
  }
  out.push(`ok   a new channel starts in "${genreAtAdd}"`);

  document.getElementById('channel-save').click();
  await wait(1200);

  if (dialog.open) return fail('the dialog stayed open after saving');
  const tile = [...document.querySelectorAll('.tv-tile')].find((t) => t.dataset.url === added);
  if (!tile) return fail('the added channel did not appear on the grid');
  if (!tile.classList.contains('is-added')) return fail('an added channel is not marked as one');
  out.push('ok   it appears on the grid, marked as hand-added');

  /* ------------------------------- filing --------------------------------- */

  const pencil = tile.querySelector('.tv-pencil');
  if (!pencil) return fail('there is no way to edit a channel from its tile');

  pencil.click();
  await wait(400);
  if (!dialog.open) return fail('the pencil did not open the editor');

  const countryValue = document.getElementById('channel-country').value;
  if (countryValue !== 'GB') return fail(`the country was not tidied (got "${countryValue}")`);

  document.getElementById('channel-genre').value = 'documentary';
  document.getElementById('channel-save').click();
  await wait(1200);

  const filing = await bridge.channels();
  const moved = filing.grouped.find((g) => g.genre === 'documentary');
  if (!moved || !moved.channels.some((c) => c.url === added)) {
    return fail('the channel could not be moved to a genre by editing');
  }
  out.push('ok   editing files it under a real genre');

  // It must still be marked as hand-added after being filed.
  const stillAdded = moved.channels.find((c) => c.url === added);
  if (stillAdded.source !== 'added') return fail('filing lost track of where it came from');

  /* ------------------------------- refusal -------------------------------- */

  addBtn.click();
  await wait(300);
  fill('channel-name', 'Nonsense');
  fill('channel-url', 'file:///etc/passwd');
  document.getElementById('channel-save').click();
  await wait(500);
  const error = document.getElementById('channel-error');
  if (!dialog.open) return fail('a file:// link was accepted');
  if (error.hidden || !error.textContent) return fail('a refused link gave no explanation');
  out.push(`ok   a link that is not a stream is refused: "${error.textContent}"`);
  document.getElementById('channel-cancel').click();
  await wait(300);

  /* ------------------------------- checking ------------------------------- */

  // Reached the way a person reaches it now: from Settings.
  document.getElementById('rail-settings').click();
  await wait(800);
  if (!document.getElementById('settings-dialog').open) return fail('settings did not open');
  document.getElementById('settings-check-now').click();
  await wait(1600);
  const sweepDialog = document.getElementById('sweep-dialog');
  if (!sweepDialog.open) return fail('the check did not open from Settings');

  // Never-checked is the default, and the copy has to say why.
  const which = sweepDialog.querySelector('input[name="which"]:checked').value;
  if (which !== 'unchecked') return fail(`the check defaults to "${which}", not the channels doing nothing`);
  const whichHint = document.getElementById('sweep-which-hint').textContent;
  if (!/doing nothing/i.test(whichHint)) return fail('the options do not explain themselves');

  // Everything, so the run covers the fixture regardless of its health state.
  sweepDialog.querySelector('input[name="which"][value="all"]').click();

  const runCheck = async (which, apply) => {
    if (!sweepDialog.open) {
      // Reopen the way a person would, rather than by reaching into internals.
      document.getElementById('rail-settings').click();
      await wait(700);
      document.getElementById('settings-check-now').click();
      await wait(1400);
    }
    sweepDialog.querySelector(`input[name="which"][value="${which}"]`).click();
    document.getElementById('sweep-start').click();
    for (let i = 0; i < 40; i += 1) {
      await wait(2000);
      if (!document.getElementById('sweep-result').hidden) break;
    }
    if (document.getElementById('sweep-result').hidden) return null;
    const outcome = {
      counts: document.getElementById('sweep-counts').textContent,
      lists: document.getElementById('sweep-lists').textContent,
      applyLabel: document.getElementById('sweep-apply').textContent,
    };
    if (apply) {
      document.getElementById('sweep-apply').click();
      await wait(1500);
    }
    return outcome;
  };

  /**
   * One check cannot hide anything on a list nobody has ever checked: nothing is
   * on three strikes yet. That is the rule doing its job, so the check runs
   * again over the channels that just failed -- which is also the cheaper set.
   */
  // A first check finds failures but hides nothing: nothing is on three strikes.
  // It still has to be savable, or that first failure is never banked and a
  // second and third can never happen.
  let result = await runCheck('all', true);
  if (!result) return fail('the first check never finished');
  if (!/checked/.test(result.counts)) return fail(`the result says nothing useful: "${result.counts}"`);
  if (!/not answering/i.test(result.lists)) return fail('a first check found failures but did not list them');
  if (!/not yet hidden/i.test(result.lists)) {
    return fail('the preview does not explain why nothing is being hidden yet');
  }
  if (!/^save results$/i.test(result.applyLabel)) {
    return fail(`a check that hides nothing offered "${result.applyLabel}"`);
  }
  out.push(`ok   a first check reports rather than hiding: "${result.counts}"`);

  // Checking on its own must never hide anything. The first check was applied,
  // but it hid nothing, so nothing should be hidden now.
  const afterSave = await bridge.debugHealth();
  if (afterSave.summary.hidden !== 0) {
    return fail(`${afterSave.summary.hidden} channels were hidden by a check that hid nothing`);
  }
  out.push('ok   checking on its own hides nothing');

  // Repeated checks on the same day must still hide nothing. The rule counts
  // *days*, so three runs an hour apart is one bad evening rather than a dead
  // channel -- and this is the assertion that keeps it that way.
  await runCheck('failed', true);
  result = await runCheck('failed', true);
  if (!result) return fail('the third check never finished');
  if (/\d+ would be hidden/.test(result.counts)) {
    return fail(`three checks in one day offered to hide (${result.counts}) -- the rule is days, not attempts`);
  }
  const sameDay = await bridge.debugHealth();
  if (sameDay.summary.hidden > 0) return fail('repeated checks on one day hid something');
  out.push('ok   three checks in one day still hide nothing, because the rule is days');

  // To reach the threshold in a check without waiting a week, the threshold is
  // set to one -- an actual setting a viewer can choose, applied through the
  // same code path as everything else.
  await bridge.setSettings({ deadDays: 1 });
  await wait(600);
  result = await runCheck('failed', true);
  if (!result) return fail('the final check never finished');

  const wouldHide = Number((result.counts.match(/(\d+) would be hidden/) || [])[1] || 0);
  if (!wouldHide) {
    return fail(`a day of failures did not reach a one-day threshold (${result.counts})`);
  }
  if (!/^hide \d+/i.test(result.applyLabel)) {
    return fail(`the offer to hide is not labelled as one: "${result.applyLabel}"`);
  }
  out.push(`ok   past the threshold it offers: ${result.counts}`);

  // The third check was run with apply, so it is applied too. Confirm the list
  // itself is untouched by any of this.
  const afterApply = await bridge.debugHealth();
  if (afterApply.summary.hidden < wouldHide) {
    return fail(`applying hid ${afterApply.summary.hidden} of ${wouldHide}`);
  }
  if (afterApply.summary.total !== afterSave.summary.total) {
    return fail(`checking changed the list itself (${afterApply.summary.total} of ${afterSave.summary.total})`);
  }
  out.push(`ok   only then does it hide: ${afterApply.summary.hidden} of ${afterApply.summary.total}`);

  // Only now. Putting the threshold back first would immediately un-hide them
  // again -- each has one day of failures against a seven-day rule -- and the
  // assertions below would be reading an empty list.
  await bridge.setSettings({ deadDays: 7 });
  await wait(600);

  /* --------------------------- hidden and back ---------------------------- */

  const hiddenToggle = document.getElementById('tv-hidden-toggle');
  if (hiddenToggle.hidden) return fail('nothing offers to show the hidden channels');
  hiddenToggle.click();
  await wait(500);

  const hiddenRow = document.getElementById('tv-hidden-row');
  const items = hiddenRow.querySelectorAll('.tv-hidden-item');
  if (!items.length) return fail('the hidden list is empty although channels are hidden');
  const text = items[0].textContent;
  if (!/put back/i.test(text)) return fail('a hidden channel offers no way back');

  document.querySelector('#tv-hidden-row .btn').click();
  await wait(1500);
  const restored = await bridge.debugHealth();
  if (restored.summary.hidden >= afterApply.summary.hidden) {
    return fail('putting a channel back did not take it off the hidden list');
  }
  out.push('ok   a hidden channel explains itself and can be put back');

  /* ------------------------------ cleaning up ----------------------------- */

  await bridge.removeChannel(added);
  const gone = await bridge.channels();
  if (gone.grouped.some((g) => g.channels.some((c) => c.url === added))) {
    return fail('a removed channel stayed on the grid');
  }
  out.push('ok   removing takes it off the grid');

  return out.join(' | ');
})();