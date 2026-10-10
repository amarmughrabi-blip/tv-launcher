'use strict';

/**
 * Ads must not be able to take over the view or the user's browser.
 *
 * The two failures this covers are both invisible in the DOM:
 *
 *   - Ads shipped in the page markup survive network blocking and sit as
 *     transparent overlays on top of the content, so a click meant for a button
 *     lands on the ad instead.
 *   - window.open() was handed straight to the system browser, so a page could
 *     open the user's browser with no click of theirs involved.
 *
 * Both are checked against a real loaded page, not a stub, because the failure
 * mode is precisely that the DOM looks fine.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const fail = (why) => {
  console.log(`verify: FAIL ${why}`);
  process.exit(1);
};

(async () => {
  const bridge = window.api;
  if (typeof bridge.debugCosmetics !== 'function') {
    return fail('debug:cosmetics missing — run with TVL_DEBUG_INPUT=1');
  }

  const faces = [...document.querySelectorAll('#picker-grid .picker-item:not(.picker-add)')];
  if (faces.length) faces[0].click();
  await wait(1500);

  const tile = document.querySelector('.tile');
  if (!tile) return fail('no tile to open');
  tile.click();
  await wait(9000);

  const state = await bridge.debugCosmetics();
  if (!state.applied) {
    return fail('no cosmetic CSS was injected — ad overlays will swallow clicks');
  }
  if (state.lastStyles < 200) {
    return fail(`cosmetic CSS looks empty (${state.lastStyles} bytes)`);
  }
  out.push(`ok   ad elements hidden (${state.lastStyles} bytes of CSS, ${state.applied}x)`);

  // The overlay problem is that something invisible sits above the content and
  // takes the click. Whatever is on top of a button must not be an ad.
  const blockers = [...document.querySelectorAll('body *')].filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    if (cs.pointerEvents === 'none') return false;
    const r = el.getBoundingClientRect();
    // Only care about things large enough to actually cover a control.
    return r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.5 && r.top <= 2 && r.left <= 2;
  });
  const adNamed = blockers.filter((el) => /ad|advert|banner|interstitial|popunder|overlay/i.test(
    `${el.id} ${el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className}`,
  ));
  if (adNamed.length) {
    return fail(`a full-window ad overlay is still on top: ${adNamed.slice(0, 3).map((e) => e.tagName + '#' + e.id).join(', ')}`);
  }
  out.push('ok   no full-window ad overlay covering the page');

  // A pop-up must not reach the system browser. window.open is how ads escape a
  // blocked request, so the probe has to run *inside the site* -- calling it
  // from the launcher would never reach the site's window-open handler, and the
  // check would pass whatever main.js did.
  //
  // The site view is a separate WebContents, so it is driven through main.
  const before = await bridge.debugPopups();
  const openedBefore = await bridge.debugExternalOpens();
  await bridge.debugSiteEval(
    "for (let i = 0; i < 5; i++) window.open('https://example.com/popup-probe', '_blank'); 'sent'",
  );
  await wait(700);
  const after = await bridge.debugPopups();
  const openedAfter = await bridge.debugExternalOpens();

  // With the guard armed the page cannot even reach the handler, so zero
  // attempts here is the correct result, not a missing probe. What matters is
  // that nothing reached the browser.
  const attempted = after.attempted - before.attempted;
  const leaked = openedAfter.openedExternally - openedBefore.openedExternally;
  if (leaked > 0) {
    return fail(`${leaked} pop-up(s) reached the system browser`);
  }
  out.push(`ok   5 site pop-ups fired, ${attempted} reached the handler, none reached the browser`);

  // --- the guard inside the page itself --------------------------------------
  // The handler above is the last line of defence. Pop-under networks exist to
  // survive exactly that, so the chain is broken at the source as well: the
  // page's own window.open is inert and cannot be redefined.
  const guard = JSON.parse(await bridge.debugSiteEval(`(() => {
    const opened = window.open('https://popunder-probe.invalid/x', '_blank');
    const d = Object.getOwnPropertyDescriptor(window, 'open');
    return JSON.stringify({
      returnsNull: opened === null,
      armed: !!window.__tvPopunderGuard,
      configurable: d ? d.configurable : null,
    });
  })()`));
  if (!guard.returnsNull) return fail('the page can still call window.open');
  if (!guard.armed) return fail('the pop-under guard is not armed in the page');
  if (guard.configurable !== false) {
    return fail('the page could redefine window.open and pop under anyway');
  }
  out.push('ok   window.open is inert inside the page and cannot be restored');

  // Beacon frames are the delivery mechanism. A late one must be swept, while a
  // real player-sized frame must survive -- breaking video would be worse than
  // the ad it prevents.
  const beacon = JSON.parse(await bridge.debugSiteEval(`(async () => {
    const small = document.createElement('iframe');
    small.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;border:0';
    document.body.appendChild(small);
    const big = document.createElement('iframe');
    big.style.cssText = 'position:fixed;bottom:0;left:0;width:640px;height:360px;border:0';
    document.body.appendChild(big);
    await new Promise((r) => setTimeout(r, 600));
    const removed = !document.body.contains(small);
    const kept = document.body.contains(big);
    big.remove();
    return JSON.stringify({ removed, kept });
  })()`));
  if (!beacon.removed) return fail('a 1x1 beacon frame was not swept');
  if (!beacon.kept) return fail('the guard removed a player-sized frame — video would break');
  out.push('ok   beacon frames swept, player-sized frames kept');

  console.log(`verify: ${out.join(' | ')}`);
  return 'ok';
})();
