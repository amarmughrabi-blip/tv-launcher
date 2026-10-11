'use strict';

/**
 * Live TV channels.
 *
 * Stored apart from profiles on purpose. The channels are the same whoever is
 * watching, and the sites list is built for web addresses -- it rejects a
 * stream URL, correctly, because it would then be treated as a page to open in
 * a window.
 *
 * On disk:
 *   channels.json  { "channels": [ { name, genre, country, res, logo, url,
 *                                    source } ] }
 *
 * `source` says where a channel came from: `master` for the imported list,
 * `added` for one the viewer put in by hand. The import replaces master entries
 * and leaves added ones alone, so re-running it cannot quietly destroy a
 * channel somebody found and kept on purpose.
 *
 * `channel-health.json` is written by the health check and merged over the
 * master list at read time, so probing never rewrites the list itself.
 *
 * A channel is kept until it has failed health checks *consecutively*. Free
 * streams drop off constantly -- roughly 44% of a community playlist was already
 * dead when it was last checked -- and a single failed probe is far more likely
 * to be a network hiccup than a channel that has gone. Dropping on the first
 * failure would empty the grid over an afternoon.
 */

/** How many consecutive failed probes before a channel stops being offered. */
const FAILURES_BEFORE_DROP = 3;

/**
 * How stale a healthy channel's timestamp may get. Long enough that a stream
 * stalling every few minutes does not rewrite the file, short enough that a
 * weekly sweep still sees it as recently checked.
 */
const SIX_HOURS = 6 * 60 * 60 * 1000;

const fs = require('node:fs');
const { paths } = require('./paths');
const { shouldCount } = require('./channel-health');

/**
 * Where a hand-added channel lands until somebody files it properly.
 *
 * It is a working pile, not a category: every channel added by hand would
 * otherwise have to be forced into one of the researched genres, and most
 * people cannot tell whether "general" or "entertainment" is right for a
 * stream they found. It sorts to the top so the pile is easy to find and easy
 * to empty.
 */
const NEW_GENRE = 'new channel';

const GENRES = [
  NEW_GENRE, 'news', 'sports', 'movies', 'series', 'entertainment', 'kids', 'family',
  'animation', 'music', 'documentary', 'classic', 'comedy', 'lifestyle',
  'business', 'culture', 'education', 'science', 'general', 'religious',
  'shop', 'cooking', 'travel', 'outdoor', 'auto', 'weather', 'relax',
  'legislative',
];

/**
 * Rough order for the genre strip. What people reach for first comes first;
 * everything else keeps its own alphabetical order after these.
 */
const GENRE_ORDER = [NEW_GENRE, 'general', 'news', 'sports', 'movies', 'series', 'kids', 'entertainment', 'music', 'documentary'];

function empty() {
  return { channels: [] };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Reject anything that is not a usable http(s) stream URL. */
function usableUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalise(record) {
  // The list is data from outside the app. One null or stray value must not take
  // the whole grid down with it.
  if (!record || typeof record !== 'object') return null;

  const name = String(record.name ?? '').trim();
  const url = usableUrl(record.url);
  if (!name || !url) return null;
  const genre = String(record.genre ?? '').trim().toLowerCase() || 'general';
  return {
    name,
    url,
    source: record.source === 'added' ? 'added' : 'master',
    genre: GENRES.includes(genre) ? genre : genre,
    country: String(record.country ?? '').trim().toUpperCase() || null,
    res: String(record.res ?? '').trim() || null,
    logo: record.logo ? String(record.logo) : null,
  };
}

/** Every channel, master list merged with the last health results. */
function all() {
  const base = readJson(paths.channelsFile(), empty());
  const health = readJson(paths.channelHealthFile(), {});

  const list = Array.isArray(base.channels) ? base.channels : [];
  const out = [];
  const seen = new Set();

  for (const record of list) {
    const channel = normalise(record);
    if (!channel) continue;
    // Keyed on the stream URL: it is what actually dies, and two entries for
    // the same stream would show as the same dead tile twice.
    if (seen.has(channel.url)) continue;
    seen.add(channel.url);

    const h = health[channel.url];
    channel.fails = h && typeof h.fails === 'number' ? h.fails : 0;
    channel.checked = h && h.at ? h.at : null;
    channel.dead = channel.fails >= FAILURES_BEFORE_DROP;
    out.push(channel);
  }
  return out;
}

/**
 * Record what happened when a channel was played, and say whether that moved it
 * closer to being hidden.
 *
 * Only hard failures count. A timeout or a geo-block says more about this
 * machine than about the channel, and counting them would hide channels that
 * work fine for someone else. A clean play resets the run.
 *
 * Returns the stored record so the caller can tell the viewer what happened.
 */
function recordResult(url, { ok, reason = null }) {
  const state = readJson(paths.channelHealthFile(), {});
  const previous = state[url] || { fails: 0 };
  const at = new Date().toISOString();

  // A live stream fires `playing` again after every stall, and each one would
  // otherwise rewrite the file for no change at all. The timestamp still moves,
  // but only every few hours, which is often enough to count as "checked".
  const settled = previous.fails === 0 && !previous.reason;
  if (ok && settled && previous.at && Date.now() - Date.parse(previous.at) < SIX_HOURS) {
    return { counted: false, reason: null, fails: 0, hidden: false };
  }

  if (!ok && !shouldCount(reason)) {
    // Soft: remembered so the UI can explain it, but the counter does not move.
    state[url] = { fails: previous.fails || 0, at, reason };
    writeHealth(state);
    return { counted: false, reason };
  }

  const fails = ok ? 0 : (previous.fails || 0) + 1;
  state[url] = { fails, at, reason: ok ? null : reason };
  writeHealth(state);

  return {
    counted: !ok,
    reason: ok ? null : reason,
    fails,
    hidden: fails >= FAILURES_BEFORE_DROP,
  };
}

/** The raw health records, for a sweep to merge into. */
function readHealth() {
  return readJson(paths.channelHealthFile(), {});
}

function writeHealth(state) {
  fs.mkdirSync(paths.appDir(), { recursive: true });
  fs.writeFileSync(paths.channelHealthFile(), `${JSON.stringify(state, null, 1)}\n`);
}

/** Drop any record for a channel, so it starts counting from nothing. */
function forget(url) {
  const state = readJson(paths.channelHealthFile(), {});
  delete state[url];
  writeHealth(state);
}

/** Bring a hidden channel back by hand. */
function restore(url) {
  forget(url);
}

/** Hide a channel now, without waiting for the counter. */
function hide(url) {
  const state = readJson(paths.channelHealthFile(), {});
  state[url] = { fails: FAILURES_BEFORE_DROP, at: new Date().toISOString(), reason: 'hidden by hand' };
  writeHealth(state);
}

/** Channels that are not currently hidden, in stable display order. */
function available() {
  return all().filter((c) => !c.dead);
}

/** Channels grouped by genre, both levels in a sensible order. */
function grouped() {
  const channels = available();
  const byGenre = new Map();
  for (const c of channels) {
    if (!byGenre.has(c.genre)) byGenre.set(c.genre, []);
    byGenre.get(c.genre).push(c);
  }

  const rank = (g) => {
    const i = GENRE_ORDER.indexOf(g);
    return i === -1 ? GENRE_ORDER.length : i;
  };

  const genres = [...byGenre.keys()].sort((a, b) => {
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.localeCompare(b);
  });

  const seenGenres = new Set();
  return genres.map((genre) => {
    const list = byGenre
      .get(genre)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    // A genre can appear twice if the data ever carries a case variant; keep the
    // first and fold the rest in rather than showing two headings.
    let key = genre;
    if (seenGenres.has(key)) key = `${genre} `;
    seenGenres.add(key);
    return { genre, channels: list };
  });
}

/** How many are hidden, so the UI can say so rather than just looking short. */
function summary() {
  const list = all();
  return {
    total: list.length,
    live: list.filter((c) => !c.dead).length,
    hidden: list.filter((c) => c.dead).length,
    genres: new Set(list.map((c) => c.genre)).size,
  };
}

function findByUrl(url) {
  return all().find((c) => c.url === url) || null;
}

/** Replace the whole list. Used by the import, not by the UI. */
function writeAll(records) {
  const seen = new Set();
  const channels = [];
  for (const record of records) {
    const channel = normalise(record);
    if (!channel || seen.has(channel.url)) continue;
    seen.add(channel.url);
    channels.push(channel);
  }
  channels.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  // Anything the viewer added by hand is kept. An import is meant to refresh the
  // researched list, not to quietly delete a stream somebody found themselves.
  const base = readJson(paths.channelsFile(), empty());
  const existing = Array.isArray(base.channels) ? base.channels : [];
  for (const record of existing) {
    const channel = normalise(record);
    if (!channel || channel.source !== 'added' || seen.has(channel.url)) continue;
    seen.add(channel.url);
    channels.push(channel);
  }

  save(channels);
  return channels.length;
}

/** The stored list, without health merged in. For editing. */
function stored() {
  const base = readJson(paths.channelsFile(), empty());
  const list = Array.isArray(base.channels) ? base.channels : [];
  const out = [];
  const seen = new Set();
  for (const record of list) {
    const channel = normalise(record);
    if (!channel || seen.has(channel.url)) continue;
    seen.add(channel.url);
    out.push(channel);
  }
  return out;
}

/** Write the list back, keeping the order it already had. */
function save(list) {
  fs.mkdirSync(paths.appDir(), { recursive: true });
  fs.writeFileSync(paths.channelsFile(), `${JSON.stringify({ channels: list }, null, 1)}\n`);
}

/**
 * Put a channel in by hand.
 *
 * It lands in the new-channel pile rather than being forced into a researched
 * genre, because guessing wrong is worse than leaving it obviously unsorted.
 */
function add(record) {
  const channel = normalise({
    ...record,
    genre: String(record.genre ?? '').trim().toLowerCase() || NEW_GENRE,
    source: 'added',
  });
  if (!channel) return { ok: false, error: 'A name and a stream link are needed' };

  const list = stored();
  if (list.some((c) => c.url === channel.url)) {
    return { ok: false, error: 'That channel is already in the list' };
  }
  list.push(channel);
  save(list);
  forget(channel.url);
  return { ok: true, channel };
}

/** Change a channel. The URL may change; the list is keyed on it, so it moves. */
function update(url, changes) {
  const list = stored();
  const at = list.findIndex((c) => c.url === url);
  if (at === -1) return { ok: false, error: 'That channel is no longer in the list' };

  const merged = normalise({ ...list[at], ...changes, url: changes.url ?? url });
  if (!merged) return { ok: false, error: 'A name and a usable stream link are needed' };
  if (merged.url !== url && list.some((c) => c.url === merged.url)) {
    return { ok: false, error: 'Another channel already uses that link' };
  }

  list[at] = merged;
  save(list);
  // Health is recorded against the old address, and means nothing for a new one.
  if (merged.url !== url) forget(url);
  return { ok: true, channel: merged };
}

/**
 * Remove a channel from the list.
 *
 * Only ever called by hand. Automatic pruning hides and never deletes, so a
 * bad sweep cannot cost somebody a channel they found themselves.
 */
function remove(url) {
  const list = stored();
  const kept = list.filter((c) => c.url !== url);
  if (kept.length === list.length) return { ok: false, error: 'That channel is not in the list' };
  save(kept);
  forget(url);
  return { ok: true };
}

/** The channels currently hidden, for the view that puts them back. */
function hidden() {
  return all().filter((c) => c.dead);
}

module.exports = {
  all,
  available,
  grouped,
  summary,
  findByUrl,
  writeAll,
  add,
  update,
  remove,
  hidden,
  stored,
  recordResult,
  readHealth,
  writeHealth,
  forget,
  restore,
  hide,
  usableUrl,
  normalise,
  FAILURES_BEFORE_DROP,
  NEW_GENRE,
  GENRES,
  GENRE_ORDER,
};