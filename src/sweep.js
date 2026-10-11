'use strict';

/**
 * Checking a batch of channels.
 *
 * Always in two steps: look, then apply. The results of a run are held in
 * memory and nothing is written until somebody confirms them. A sweep that
 * hides as it goes cannot be taken back if it was wrong, and a sweep that is
 * wrong is indistinguishable from a broken app -- the grid just looks short.
 *
 * The choice of what to check exists because the sets are not the same:
 *
 *   all       everything. Expensive, and most of it is already known.
 *   unchecked never checked before. The default, because these are the channels
 *             nobody has opened, so nothing is known about whether they work.
 *   failed    channels that have failed before. For a second opinion on ones
 *             that are already on their way out.
 */

const { probe, classify } = require('./channel-probe');
const { shouldCount } = require('./channel-health');
const { FAILURES_BEFORE_DROP } = require('./channels');

const DEFAULT_CONCURRENCY = 8;

/** Pick the channels a run is about. */
function select(list, which) {
  if (which === 'all') return list;
  if (which === 'failed') return list.filter((c) => c.fails > 0);
  return list.filter((c) => !c.checked);
}

/**
 * Check a batch and return what would change, writing nothing.
 *
 * @param {Array}  list       channels to consider
 * @param {object} options    { which, deep, concurrency }
 * @param {function} [onProgress] called with { done, total, name }
 */
async function sweep(list, options = {}, onProgress) {
  const { which = 'unchecked', deep = false, concurrency = DEFAULT_CONCURRENCY } = options;
  const targets = select(list, which);

  const results = new Map();
  let done = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length) {
      const channel = targets[cursor];
      cursor += 1;

      let reason = 'unknown';
      try {
        reason = classify(await probe(channel.url, { deep }));
      } catch {
        // A probe that throws is not evidence either way, so it must not count.
        reason = 'unknown';
      }

      const previous = channel.fails || 0;
      const ok = reason === 'ok';
      results.set(channel.url, {
        url: channel.url,
        name: channel.name,
        reason,
        ok,
        counted: !ok && shouldCount(reason),
        previousFails: previous,
        fails: ok ? 0 : previous,
        wouldHide: !ok && shouldCount(reason) && previous + 1 >= FAILURES_BEFORE_DROP,
        recovered: ok && previous > 0,
      });

      done += 1;
      if (onProgress) onProgress({ done, total: targets.length, name: channel.name });
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const all_ = [...results.values()];
  return {
    targets: targets.length,
    checked: all_.length,
    wouldHide: all_.filter((r) => r.wouldHide).length,
    recovered: all_.filter((r) => r.recovered).length,
    // Failures we could not judge: a timeout, a block, anything uncertain.
    // Listed separately so a sweep that cannot tell is never read as a sweep
    // that found nothing wrong.
    uncertain: all_.filter((r) => !r.ok && !r.counted).length,
    live: all_.filter((r) => r.ok).length,
    results: all_,
  };
}

/**
 * Write a confirmed sweep's results.
 *
 * Only what was actually counted moves; uncertain failures are recorded so the
 * player can explain them, and leave the counter alone.
 */
function apply(report, health) {
  const state = { ...health };
  const at = new Date().toISOString();
  const newlyHidden = [];

  for (const entry of report.results) {
    if (entry.ok) {
      state[entry.url] = { fails: 0, at, reason: null };
      continue;
    }
    const fails = entry.counted ? entry.fails + 1 : entry.previousFails;
    state[entry.url] = { fails, at, reason: entry.reason };
    if (entry.counted && fails >= FAILURES_BEFORE_DROP) newlyHidden.push(entry);
  }

  // What the caller needs is how many went away, not just the file. A sweep that
  // changed nothing and one that hid forty both "succeeded" otherwise.
  return { state, hidden: newlyHidden };
}

module.exports = { sweep, apply, select, DEFAULT_CONCURRENCY };