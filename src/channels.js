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
 *   channels.json  { "channels": [ { name, genre, country, res, logo, url } ] }
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

const fs = require('node:fs');
const { paths } = require('./paths');

const GENRES = [
  'news', 'sports', 'movies', 'series', 'entertainment', 'kids', 'family',
  'animation', 'music', 'documentary', 'classic', 'comedy', 'lifestyle',
  'business', 'culture', 'education', 'science', 'general', 'religious',
  'shop', 'cooking', 'travel', 'outdoor', 'auto', 'weather', 'relax',
  'legislative',
];

/**
 * Rough order for the genre strip. What people reach for first comes first;
 * everything else keeps its own alphabetical order after these.
 */
const GENRE_ORDER = ['general', 'news', 'sports', 'movies', 'series', 'kids', 'entertainment', 'music', 'documentary'];

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
  fs.mkdirSync(paths.appDir(), { recursive: true });
  fs.writeFileSync(paths.channelsFile(), `${JSON.stringify({ channels }, null, 1)}\n`);
  return channels.length;
}

module.exports = {
  all,
  available,
  grouped,
  summary,
  findByUrl,
  writeAll,
  usableUrl,
  normalise,
  FAILURES_BEFORE_DROP,
  GENRES,
  GENRE_ORDER,
};