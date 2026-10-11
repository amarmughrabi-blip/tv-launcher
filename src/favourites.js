'use strict';

/**
 * Favourites.
 *
 * A short list of channels somebody actually watches, kept beside the channels
 * rather than inside a profile. The same reasoning as the channel store: this is
 * the same for whoever is sitting down, and the whole point is to avoid hunting
 * past thirty documentary channels to reach one you have watched a hundred
 * times.
 *
 * Keyed on the stream URL, like everything else about channels, because that is
 * what a channel is -- the address it plays from. A favourite that outlives the
 * channel it named is not a favourite, it is a broken link in a list, so reading
 * one back checks it is still in the list before offering it.
 */

const fs = require('node:fs');
const { paths } = require('./paths');
const { all } = require('./channels');

const MAX = 200;

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.favouritesFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((u) => typeof u === 'string' && u) : [];
  } catch {
    return [];
  }
}

function write(urls) {
  fs.mkdirSync(paths.appDir(), { recursive: true });
  fs.writeFileSync(paths.favouritesFile(), `${JSON.stringify([...new Set(urls)].slice(0, MAX), null, 1)}\n`);
}

/** Every starred URL, in the order they were starred. */
function urls() {
  return read();
}

function has(url) {
  return read().includes(url);
}

/**
 * Star or unstar. Returns the new state, so the caller does not have to guess
 * what happened -- a toggle that is applied optimistically and is quietly wrong
 * leaves the star lying about the list.
 */
function toggle(url) {
  if (typeof url !== 'string' || !url) return { ok: false, starred: false };
  const current = read();
  const starred = !current.includes(url);
  const next = starred ? [...current, url] : current.filter((u) => u !== url);
  write(next);
  return { ok: true, starred, urls: next };
}

/**
 * The favourite channels, as channel records.
 *
 * Anything starred that is no longer in the list, or has been hidden as dead, is
 * dropped here rather than offered and then failing. A favourite that has gone
 * quiet is not something to put in front of somebody.
 */
function channels() {
  const starred = new Set(read());
  const live = all().filter((c) => !c.dead && starred.has(c.url));
  return live.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * Starred but no longer playable.
 *
 * Worth surfacing rather than silently dropping: a favourite that has gone is
 * the one you want to know about, and it is the one that would otherwise leave
 * you wondering where a channel went.
 */
function missing() {
  const starred = new Set(read());
  const known = new Set(all().map((c) => c.url));
  return [...starred].filter((url) => !known.has(url));
}

module.exports = { urls, has, toggle, channels, missing, MAX };