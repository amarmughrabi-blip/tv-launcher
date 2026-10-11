'use strict';

/**
 * How long the launcher takes to become usable.
 *
 * The failure this exists to catch is the loading screen. It is not a cosmetic
 * problem: startup used to await Widevine, which can take the best part of a
 * minute, and then await a filter parse that blocks the main process for four
 * seconds. So the window sat on a loading screen saying "Loading ad blocking"
 * while the app was neither loading nor accepting anything, and there was nothing
 * the viewer could do about it.
 *
 * Timed in the main process and read back over IPC, not in the renderer. The
 * verification script is injected after the app has settled, so asking the page
 * how long the loading screen was up always answers "not at all" -- which is how
 * a check meant to catch a 45-second hang passes on the build that has one.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const fail = (msg) => `FAIL ${msg} | ${out.join(' | ')}`;

/** Generous enough for painting a window on a slow disk, far under a hang. */
const USABLE_BUDGET_MS = 2000;

(async () => {
  const bridge = window.api;

  // --- how long did startup take -------------------------------------------
  let boot = null;
  for (let i = 0; i < 100; i += 1) {
    boot = await bridge.debugBootTime();
    if (boot && boot.usableMs !== null) break;
    await wait(100);
  }
  if (!boot || boot.usableMs === null) return fail('startup never reported a time');
  if (!boot.ready) return fail('main still thinks it is starting up');

  if (boot.usableMs > USABLE_BUDGET_MS) {
    return fail(
      `the launcher took ${boot.usableMs}ms to be usable -- that is a hang, not a start`,
    );
  }
  out.push(`ok   the launcher is usable ${boot.usableMs}ms after start`);

  // --- and it is genuinely usable ------------------------------------------
  if (!document.getElementById('picker')) return fail('the profile picker is missing');
  const rail = document.querySelectorAll('.rail-btn').length;
  if (rail < 4) return fail(`the rail is not drawn (${rail} buttons)`);
  if (document.getElementById('boot') && !document.getElementById('boot').hidden) {
    return fail('the loading screen is still up');
  }
  out.push('ok   the launcher is drawn, with the loading screen gone');

  // --- blocking is real, and was never what made the launcher wait ----------
  let stats = null;
  for (let i = 0; i < 200; i += 1) {
    stats = await bridge.debugBlocker();
    if (stats && stats.ready) break;
    await wait(100);
  }
  if (!stats || !stats.ready) return fail('the filter engine never became ready');
  out.push('ok   blocking is ready');

  if (!boot.blockingMs) return fail('blocking never reported a time');
  // The whole point: blocking finishes on its own schedule and the launcher did
  // not wait for it. If these were ever the same number again, the ordering has
  // gone back to blocking the launcher on the filter parse.
  if (boot.blockingMs <= boot.usableMs) {
    return fail(
      `blocking was ready at ${boot.blockingMs}ms, no later than the launcher at ` +
        `${boot.usableMs}ms -- the launcher is waiting on the filter parse again`,
    );
  }
  out.push(
    `ok   blocking finished behind the launcher, not in front of it ` +
      `(${boot.blockingMs}ms vs ${boot.usableMs}ms)`,
  );

  // --- and the engine it ended up with actually works ------------------------
  // A restored engine that does not block would be worse than no engine at all,
  // so this asks it to do its job rather than trusting a filter count.
  if (!stats.enabled) return fail('blocking is off by default');
  if (await bridge.debugExempt('ad.doubleclick.net')) {
    return fail('an ad host is exempt out of the box');
  }
  out.push('ok   the engine that loaded is switched on and not exempting ads');

  return out.join(' | ');
})();