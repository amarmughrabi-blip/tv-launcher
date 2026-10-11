'use strict';

/**
 * A broken channel has to explain itself, and only a broken one may be counted.
 *
 * Three things have to hold at once:
 *
 *  - a dead channel says what is wrong in words, not in error codes
 *  - that failure counts towards hiding, because the host really is gone
 *  - hiding can be undone, because a wrong hide should never be permanent
 *
 * The last one matters most. A geo-block arrives looking exactly like a failure,
 * and a channel that works for someone else must not disappear for good.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;

const DEAD_URL = 'http://127.0.0.1:9/dead.m3u8';
/** Words a person can act on, rather than a network code. */
const IN_WORDS = /nothing is listening|stream address no longer exists|there is no tv stream/i;

(async () => {
  const bridge = window.api;

  const faces = [...document.querySelectorAll('#picker-grid .picker-item:not(.picker-add)')];
  if (faces.length) faces[0].click();
  await wait(1500);

  // --- open the player on a channel whose host is not listening -------------
  const opened = await bridge.playChannel(DEAD_URL);
  if (!opened || !opened.ok) return fail(`could not open the player (${JSON.stringify(opened)})`);

  // The page has to load, try, fail, and then wait for main to say why. That is
  // a page load plus a fetch, so give it room before judging.
  await wait(9000);

  const ui = JSON.parse(await bridge.debugPlayerUI());
  if (!ui.problemShown) return fail('a channel that cannot play showed no explanation');

  if (!IN_WORDS.test(ui.problemDetail)) {
    return fail(`the explanation is not in words: "${ui.problemDetail}"`);
  }
  // The old panel showed "networkManifestLoadError", which tells nobody anything.
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|manifestLoad|undefined|\[object/.test(ui.problemDetail)) {
    return fail(`the explanation leaks a raw error: "${ui.problemDetail}"`);
  }
  out.push(`ok   the failure explains itself: "${ui.problemDetail}"`);

  if (!ui.problemCounted) return fail('a dead channel did not say that it had been counted');
  out.push(`ok   it says where it stands: "${ui.problemCounted}"`);

  if (!ui.hideButtonShown) {
    return fail('a genuinely dead channel should offer to hide itself');
  }
  out.push('ok   a hard failure offers to hide the channel');

  // --- the count really moved ------------------------------------------------
  const health = await bridge.debugHealth();
  const dead = health.records.find((r) => /dead channel/i.test(r.name));
  if (!dead) return fail('the dead channel was not recorded at all');
  if (!(dead.fails >= 1)) return fail(`a dead host did not count (fails=${dead.fails})`);
  out.push(`ok   it counts towards hiding (${dead.fails} of 3)`);

  // --- and none of it is permanent -------------------------------------------
  await bridge.restoreChannel(DEAD_URL);
  const after = await bridge.debugHealth();
  const restored = after.records.find((r) => /dead channel/i.test(r.name));
  if (restored && restored.fails > 0) {
    return fail('restoring a channel did not clear its history');
  }
  if (!(after.summary.live >= 2)) {
    return fail(`the channel did not come back (live=${after.summary.live})`);
  }
  out.push('ok   it can be unhidden, and the count resets with it');

  // --- the list itself is never rewritten ------------------------------------
  const total = after.summary.total;
  await bridge.hideChannel('https://example.com/news.m3u8');
  const hidden = await bridge.debugHealth();
  if (!(hidden.summary.hidden >= 1)) return fail('hiding by hand did nothing');
  if (hidden.summary.total !== total) {
    return fail(`hiding changed the list itself (${hidden.summary.total} of ${total})`);
  }
  await bridge.restoreChannel('https://example.com/news.m3u8');
  out.push(`ok   hiding only ever hides (${total} channels either way)`);

  // --- a host that answers with HTML is dead, and is counted -----------------
  // This is the other hard case: the address is reachable and returns 200, but
  // the body is a web page rather than a stream. The channel is gone.
  await bridge.playChannel('https://example.com/news.m3u8');
  await wait(9000);
  const html = await bridge.debugHealth();
  const bbc = html.records.find((r) => /bbc news/i.test(r.name));
  if (!bbc || bbc.fails < 1) {
    return fail('a URL that returns a web page instead of a stream was not counted');
  }
  out.push('ok   an address with no stream behind it counts too');

  // --- a channel that is merely unreachable is not counted --------------------
  // This is the rule that protects channels blocked by geo rather than dead.
  // 192.0.2.1 is reserved and unroutable, so the request hangs and times out --
  // which is what a geo-block and a bad network both look like from here.
  await bridge.playChannel('http://192.0.2.1:8080/hangs.m3u8');

  // This one has to time out twice over -- once in the player, which waits ten
  // seconds for a manifest, and again in main's own probe. A fixed wait would
  // either be too short and read the previous channel's verdict, or waste a
  // minute on a machine that answered quickly.
  let softUi = null;
  for (let i = 0; i < 25; i += 1) {
    await wait(2000);
    softUi = JSON.parse(await bridge.debugPlayerUI());
    // Wait for the verdict, not just the notice: the panel says "Checking" the
    // moment the page gives up, and main still owes an answer at that point.
    if (softUi.problemCounted) break;
  }

  if (!softUi.problemCounted) return fail('the unreachable channel was never explained');
  // The panel must be about this channel, not a verdict left over from the last.
  if (/taken down|no longer exists/i.test(softUi.problemDetail)) {
    return fail(`the panel still showed the previous channel's verdict: "${softUi.problemDetail}"`);
  }
  if (!/cannot be reached|timed out in time|temporary|did not respond/i.test(softUi.problemDetail)) {
    return fail(`a timeout was not explained as one: "${softUi.problemDetail}"`);
  }

  const soft = await bridge.debugHealth();
  const hanging = soft.records.find((r) => /unreachable/i.test(r.name));
  if (hanging && hanging.fails > 0) {
    return fail(`a host that never answered was counted (fails=${hanging.fails})`);
  }
  if (!softUi.problemCounted || !/not counted|temporary|blocked/i.test(softUi.problemCounted)) {
    return fail(`an uncertain failure did not say so: "${softUi.problemCounted}"`);
  }
  if (softUi.hideButtonShown) {
    return fail('an uncertain failure offered to hide the channel by hand');
  }
  out.push(`ok   an unreachable host is explained but not counted: "${softUi.problemCounted}"`);

  await bridge.closePlayer();
  await wait(800);

  return out.join(' | ');
})();