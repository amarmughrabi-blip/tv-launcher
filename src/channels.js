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

/**
 * How many days in a row a channel must fail before it stops being offered.
 *
 * Days, not attempts, and that is the whole point. Three failed probes on a
 * Tuesday evening is a bad network; a channel lost to a bad Tuesday is one
 * somebody has to find again by hand. Counting calendar days means a burst of
 * failures in one evening costs a channel nothing, and only a stream that is
 * broken day after day earns its place off the grid.
 *
 * Read from settings so it can be changed; this is the fallback used when the
 * settings module is not in play (the CLI health check, and tests).
 */
function deadDays() {
  try {
    return require('./settings').get('deadDays');
  } catch {
    return DEFAULT_DEAD_DAYS;
  }
}

const DEFAULT_DEAD_DAYS = 7;

/**
 * The calendar day a timestamp falls on.
 *
 * Local time, deliberately. "Failed on Tuesday" has to mean the day the viewer
 * remembers failing on, and UTC would put a late-evening failure on the next day
 * for anyone east of Greenwich.
 */
function dayKey(value) {
  const when = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(when.getTime())) return null;
  const y = when.getFullYear();
  const m = String(when.getMonth() + 1).padStart(2, '0');
  const d = String(when.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The day before a `YYYY-MM-DD` key. */
function previousDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - 1);
  return dayKey(date);
}

/**
 * How many consecutive days, ending today, have a recorded failure.
 *
 * Yesterday counts as the end of the run when today has no entry yet, so a
 * channel that has failed every day for a week is not rescued by a sweep that
 * has not run yet this morning. Any gap ends the run.
 */
function streakDays(days, today = dayKey(new Date())) {
  if (!Array.isArray(days) || !days.length || !today) return 0;
  const set = new Set(days);

  let cursor = set.has(today) ? today : previousDay(today);
  let count = 0;
  while (cursor && set.has(cursor)) {
    count += 1;
    cursor = previousDay(cursor);
  }
  return count;
}

/**
 * Whether a health record has failed for long enough to be hidden.
 *
 * Reads the record's own day list rather than a stored verdict, so a channel
 * hidden last week comes back on its own once a check finds it working.
 */
function isDead(record, threshold = deadDays()) {
  if (!record) return false;
  // The current result has to agree with the history. A record whose last check
  // succeeded is not a channel that is failing, however many days it managed
  // before that -- and requiring both means a stale day list left behind by an
  // older version of this file cannot hide anything on its own.
  if (!record.fails) return false;
  return streakDays(record.days) >= threshold;
}

/** The most recent few days a channel has failed on, newest first. */
function failedDays(record, keep = 60) {
  if (!record || !Array.isArray(record.days)) return [];
  return [...new Set(record.days)].sort().reverse().slice(0, keep);
}

/** Add a counted failure, keeping the record bounded. */
function noteFailure(record, when = new Date()) {
  const key = dayKey(when);
  const days = failedDays(record, 60);
  if (key && !days.includes(key)) days.unshift(key);
  return days;
}

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
    channel.streak = streakDays(h && h.days);
    channel.dead = isDead(h);
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
  const threshold = deadDays();

  // A live stream fires `playing` again after every stall, and each one would
  // otherwise rewrite the file for no change at all. The timestamp still moves,
  // but only every few hours, which is often enough to count as "checked".
  const settled = previous.fails === 0 && !previous.reason;
  if (ok && settled && previous.at && Date.now() - Date.parse(previous.at) < SIX_HOURS) {
    return { counted: false, reason: null, fails: 0, hidden: false };
  }

  if (!ok && !shouldCount(reason)) {
    // Soft: remembered so the UI can explain it, but the day list does not move.
    // A timeout must never be able to age a channel off the grid.
    state[url] = { ...previous, fails: previous.fails || 0, at, reason };
    writeHealth(state);
    return { counted: false, reason, streak: streakDays(previous.days) };
  }

  const fails = ok ? 0 : (previous.fails || 0) + 1;
  const days = ok ? [] : noteFailure(previous);
  state[url] = { fails, days, at, reason: ok ? null : reason };
  writeHealth(state);

  return {
    counted: !ok,
    reason: ok ? null : reason,
    fails,
    streak: streakDays(days),
    hidden: streakDays(days) >= threshold,
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
  // Marked with every day back to the threshold, so a by-hand hide reads the
  // same way as one earned by failing -- and comes back the same way, on the
  // first check that finds it working.
  const threshold = Math.max(1, deadDays());
  const days = [];
  for (let i = 0; i < threshold; i += 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    days.push(dayKey(date));
  }
  state[url] = { fails: threshold, days, at: new Date().toISOString(), reason: 'hidden by hand' };
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
  dayKey,
  previousDay,
  streakDays,
  isDead,
  failedDays,
  noteFailure,
  deadDays,
  DEFAULT_DEAD_DAYS,
  NEW_GENRE,
  GENRES,
  GENRE_ORDER,
};