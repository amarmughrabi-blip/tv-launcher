'use strict';

/**
 * The genre strip.
 *
 * Twenty-eight genres will not fit across a television. The strip scrolls, and
 * the failure worth catching is the one where it does not *look* like it scrolls:
 * a hidden scrollbar plus a chip sheared off mid-word reads as a row somebody
 * cut short rather than a control you can move along.
 *
 * So the assertions are about affordance, not just about scrolling -- that
 * there is a scrollbar, that the ends fade, and that the fades appear at the
 * right end and not the wrong one.
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
  const wrap = document.getElementById('tv-genres-wrap');
  if (!strip || !wrap) return fail('the genre strip is missing');
  if (strip.parentElement !== wrap) {
    return fail('the strip is not inside its scroll wrapper');
  }

  // Narrowed first, because a check that only runs at full width proves nothing
  // about a screen small enough to need scrolling.
  await bridge.debugResize(760, 900);
  await wait(600);

  /*
   * The fixture carries a handful of genres; the real list carries twenty-eight.
   * With too few chips the strip fits and there is nothing to test -- which is
   * the strip behaving correctly, and the check learning nothing. So when it
   * does not overflow, borrow enough chips to make it, and give them back.
   * What is under test is the scrolling and the affordance, and those depend
   * only on there being more strip than window.
   */
  const borrowed = [];
  if (strip.scrollWidth <= strip.clientWidth) {
    for (let i = 0; i < 20 && strip.scrollWidth <= strip.clientWidth + 400; i += 1) {
      const chip = document.createElement('button');
      chip.className = 'tv-genre';
      chip.type = 'button';
      chip.dataset.genre = `borrowed-${i}`;
      chip.textContent = `borrowed genre ${i}`;
      strip.appendChild(chip);
      borrowed.push(chip);
    }
    await wait(300);
    out.push('ok   (the fixture has too few genres to overflow, so the strip borrowed some)');
  }

  const slack = strip.scrollWidth - strip.clientWidth;
  if (slack <= 0) return fail('the strip is not scrollable at 760px -- nothing to test');
  out.push(`ok   the strip scrolls (${slack}px beyond the edge at 760px)`);

  /* ------------------------------ the scrollbar --------------------------- */

  // A stylesheet rule is the only thing that can say whether a scrollbar is
  // drawn: it is not in the DOM and not in any computed style of an element.
  const rules = [...document.styleSheets]
    .flatMap((sheet) => {
      try {
        return [...sheet.cssRules];
      } catch {
        return [];
      }
    })
    .filter((r) => r.selectorText && r.selectorText.includes('tv-genres::-webkit-scrollbar'));
  if (!rules.length) return fail('no scrollbar styling at all for the strip');

  const hidden = rules.some((r) => /display:\s*none/.test(r.cssText));
  const sized = rules.some((r) => /height:\s*\d/.test(r.cssText));
  if (hidden) return fail('the scrollbar is still hidden -- the strip does not look scrollable');
  if (!sized) return fail('the scrollbar is not given a height, so it draws at full size');
  out.push('ok   the scrollbar is drawn, thin and themed');

  /* -------------------------------- the fades ----------------------------- */

  const at = (left) => {
    strip.scrollLeft = left;
    // Chromium throttles scroll events while the window is unfocused, so the
    // change is made the same way the app makes it: by dispatching the event the
    // listener is waiting for.
    strip.dispatchEvent(new Event('scroll'));
    return {
      left: Math.round(strip.scrollLeft),
      atStart: wrap.classList.contains('has-more-left'),
      atEnd: wrap.classList.contains('has-more-right'),
    };
  };

  const start = at(0);
  if (start.atStart) return fail('there is a fade on the left at the left edge');
  if (!start.atEnd) return fail('nothing marks that there is more to the right');

  const end = at(strip.scrollWidth);
  if (end.left < slack - 8) return fail(`the strip would not scroll to its end (${end.left} of ${slack})`);
  if (!end.atStart) return fail('there is no fade on the left once scrolled away from it');
  if (end.atEnd) return fail('there is a fade on the right at the right edge');
  out.push('ok   the fade is on the end that has more, and only that one');

  const middle = at(Math.round(slack / 2));
  if (!middle.atStart || !middle.atEnd) return fail('midway, both ends should be faded');
  out.push('ok   midway, both ends are faded');

  /* ------------------------------- the keyboard --------------------------- */

  // This is a television launcher. A remote has no wheel, so left and right on
  // the strip are how anybody gets along it.
  at(0);
  document.body.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await wait(700);
  const afterKey = Math.round(strip.scrollLeft);
  if (afterKey <= 0) return fail('the right arrow did not move the strip');

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await wait(700);
  if (Math.round(strip.scrollLeft) >= afterKey) return fail('the left arrow did not move it back');
  out.push('ok   the arrow keys move the strip, for a remote as well as a mouse');

  /* --------------------------- choosing a genre --------------------------- */

  // A genre chosen by click has to be brought into view, or clicking one and
  // watching nothing happen is the same complaint as a strip that does not scroll.
  const real = [...strip.querySelectorAll('.tv-genre')]
    .filter((c) => !c.dataset.genre.startsWith('borrowed-') && c.dataset.genre !== 'all');
  if (!real.length) return fail('no real genres to choose from');
  const wanted = real[real.length - 1].dataset.genre;
  at(0);
  strip.querySelector(`.tv-genre[data-genre="${CSS.escape(wanted)}"]`).click();
  await wait(900);

  // Re-queried, not held: choosing a genre rebuilds the strip, so the node that
  // was clicked is detached and measures zero by zero.
  const chosen = strip.querySelector(`.tv-genre[data-genre="${CSS.escape(wanted)}"]`);
  if (!chosen) return fail('the chosen genre vanished from the strip');
  const lastBox = chosen.getBoundingClientRect();
  const stripBox = strip.getBoundingClientRect();
  if (lastBox.right > stripBox.right + 4 || lastBox.left < stripBox.left - 4) {
    return fail('a genre chosen by click was not brought into view');
  }
  if (!chosen.classList.contains('is-active')) return fail('the chosen genre did not become the active one');
  out.push('ok   a genre chosen by click is scrolled into view and selected');

  // Give the borrowed chips back.
  for (const chip of borrowed) chip.remove();

  await bridge.debugResize(1280, 900);
  return out.join(' | ');
})();