'use strict';

/**
 * The genre strip.
 *
 * It used to scroll sideways with its scrollbar hidden, so twenty-eight genres
 * ended in a chip sheared off mid-word with nothing to say it went anywhere --
 * and, worse, half the genres were behind a scroll nobody was going to discover
 * on a television.
 *
 * So it wraps. The rule being defended is simple and absolute: no genre may be
 * out of sight. Anything that makes a chip unreachable fails here, and that
 * includes the scroll affordances that are no longer supposed to be needed.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;

(async () => {
  const bridge = window.api;
  const faces = [...document.querySelectorAll('#picker-grid .picker-item:not(.picker-add)')];
  if (faces.length) faces[0].click();
  await wait(1500);

  document.querySelector('.rail-btn[data-tab="tv"]').click();
  await wait(2000);

  const strip = document.getElementById('tv-genres');
  if (!strip) return fail('the genre strip is missing');

  const chips = [...strip.querySelectorAll('.tv-genre')];
  if (chips.length < 5) return fail(`only ${chips.length} genres in the strip`);

  /* --------------------- every genre must be visible ---------------------- */

  const box = strip.getBoundingClientRect();
  const hidden = [];
  for (const chip of chips) {
    const r = chip.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) hidden.push(`${chip.dataset.genre} (not drawn)`);
    else if (r.right > box.right + 2) hidden.push(`${chip.dataset.genre} (past the right edge)`);
    else if (r.left < box.left - 2) hidden.push(`${chip.dataset.genre} (past the left edge)`);
    else if (r.bottom > box.bottom + 2) hidden.push(`${chip.dataset.genre} (below the strip)`);
  }
  if (hidden.length) {
    return fail(`these genres are out of sight and would need scrolling: ${hidden.slice(0, 6).join(', ')}`);
  }
  out.push(`ok   all ${chips.length} genres are on screen at once`);

  /* ---------------------------- they must fit ----------------------------- */

  // Small enough to be read, big enough to be aimed at with a remote.
  const sample = chips[0].getBoundingClientRect();
  if (sample.height < 20) return fail(`the chips are ${Math.round(sample.height)}px tall -- unreadable`);
  if (sample.height > 38) return fail(`the chips are ${Math.round(sample.height)}px tall -- no smaller than before`);
  out.push(`ok   the chips are ${Math.round(sample.width)}x${Math.round(sample.height)}, down from 90x38`);

  // A strip that fits needs no scrolling, so nothing should be cut off and
  // nothing should be inviting a scroll that cannot happen.
  if (strip.scrollWidth > strip.clientWidth + 2) {
    return fail('the strip still overflows sideways despite wrapping');
  }
  out.push('ok   nothing is cut off, so there is nothing to scroll');

  /* ------------------- and it wraps when there are many ------------------ */

  // The shipped fixture carries a handful of genres where the real list has
  // twenty-eight, so it fits on one row and proves nothing about wrapping. Chips
  // are borrowed to make it overflow and handed back afterwards -- what is under
  // test is the layout, and that depends only on there being more genres than
  // fit.
  const borrowed = [];
  while (strip.children.length < 40) {
    const chip = document.createElement('button');
    chip.className = 'tv-genre';
    chip.type = 'button';
    chip.dataset.genre = `borrowed-${borrowed.length}`;
    chip.textContent = `borrowed ${borrowed.length}`;
    strip.appendChild(chip);
    borrowed.push(chip);
  }
  await wait(400);

  const many = [...strip.querySelectorAll('.tv-genre')];
  const manyRows = new Set(many.map((c) => Math.round(c.getBoundingClientRect().top)));
  const manyBox = strip.getBoundingClientRect();
  const cutOff = many.filter((c) => {
    const r = c.getBoundingClientRect();
    return r.right > manyBox.right + 2 || r.left < manyBox.left - 2;
  });
  if (cutOff.length) {
    return fail(`${cutOff.length} of ${many.length} genres are cut off even with wrapping`);
  }
  if (manyRows.size < 2) return fail(`${many.length} genres fitted on one row -- the chips have not shrunk`);
  out.push(`ok   ${many.length} genres wrap onto ${manyRows.size} rows with none cut off`);

  for (const chip of borrowed) chip.remove();
  await wait(200);

  /* ------------------------ the narrow-window case ------------------------ */

  // Squeezed, the chips have to keep working: every one still readable and
  // still clickable, and the ones that drop below the fold reachable.
  await bridge.debugResize(700, 900);
  await wait(700);
  const narrow = [...strip.querySelectorAll('.tv-genre')];
  const narrowHidden = narrow.filter((c) => c.getBoundingClientRect().width === 0);
  if (narrowHidden.length) {
    return fail(`${narrowHidden.length} genres disappeared at 700px`);
  }
  // Still hittable: a chip must be the topmost thing at its own centre.
  let covered = 0;
  for (const chip of narrow) {
    const r = chip.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) continue;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && !chip.contains(hit) && hit !== chip) covered += 1;
  }
  if (covered > 0) return fail(`${covered} genres are painted over by something else`);
  out.push(`ok   at 700px every genre is still drawn and still clickable (${narrow.length})`);

  await bridge.debugResize(1280, 900);
  await wait(400);

  /* ------------------------- choosing still works ------------------------- */

  const real = narrow.filter((c) => c.dataset.genre !== 'all');
  const wanted = real[real.length - 1].dataset.genre;
  strip.querySelector(`.tv-genre[data-genre="${CSS.escape(wanted)}"]`).click();
  await wait(800);
  const chosen = strip.querySelector(`.tv-genre[data-genre="${CSS.escape(wanted)}"]`);
  if (!chosen || !chosen.classList.contains('is-active')) {
    return fail(`choosing ${wanted} did not make it the active genre`);
  }
  const cb = chosen.getBoundingClientRect();
  const sb = strip.getBoundingClientRect();
  if (cb.right > sb.right + 2 || cb.left < sb.left - 2) {
    return fail('the chosen genre was not brought into view');
  }
  out.push('ok   choosing a genre still selects it and brings it into view');

  return out.join(' | ');
})();