'use strict';

/**
 * Settings.
 *
 * Kept apart from profiles on purpose. A profile is "whose apps are these"; a
 * setting is "how this launcher behaves". They get out of step — one person
 * changes a setting, another profile should not silently inherit it — and
 * putting them in the same file makes the wrong thing easy.
 *
 * Every value has a default, and every default is chosen so that a fresh install
 * behaves sensibly without anyone opening the settings screen. Reading a setting
 * must never be able to return undefined: the channels grid, the player and the
 * blocker all read these on paths where a missing key would be a crash rather
 * than a default.
 *
 * Stored as a flat object of primitives and small arrays. Anything richer
 * belongs in its own file -- channels have one, health has one -- because a
 * settings file that grows into megabytes is a sign it is really data.
 */

const fs = require('node:fs');
const { paths } = require('./paths');

/**
 * The defaults, with the reasoning kept next to them.
 *
 * These are the values the user argued for, and the reasons are here so a future
 * change does not quietly undo a decision made on purpose.
 */
const DEFAULTS = {
  /* ----------------------------- channels ----------------------------- */

  /**
   * Which genres appear on the TV page. `null` means "every genre", which is
   * what a fresh install gets.
   *
   * The argument for choosing: four of the twenty-seven genres hold five
   * channels or fewer, and "Legislative (2)" is a heading that costs a whole row
   * of the strip to say almost nothing. So the default is every genre -- a
   * curated shortlist would be somebody else's taste -- and the user ticks off
   * the clutter.
   */
  hiddenGenres: [],

  /**
   * How often channels are checked for dead links: 'launch', 'weekly', or
   * 'never'.
   *
   * 'never' by default, and that is deliberate. A sweep is 453 requests, it
   * hides channels the viewer did not choose to lose, and doing it behind
   * somebody's back on every launch is exactly the "auto-pruning with no human
   * in the loop" that empties a grid and looks like a broken app. The automatic
   * half -- noticing a channel that fails while you are watching it -- is always
   * on, because it costs nothing and only ever touches what was already on screen.
   */
  checkSchedule: 'never',

  /**
   * How many days in a row a channel must fail before it stops being offered.
   *
   * Seven, not three. The count that matters is days, not attempts: three
   * failures in one evening is a bad network, and a channel lost to a bad
   * Tuesday is a channel somebody has to find again by hand.
   */
  deadDays: 7,

  /**
   * Only offer channels from these countries. Empty means "wherever they are",
   * which is the default -- a channel being geo-locked is discovered by watching
   * it, and guessing wrong hides channels that work perfectly well.
   */
  region: [],

  /* ----------------------------- playback ----------------------------- */

  /**
   * Start every channel silent.
   *
   * On, because nobody wants a channel making noise the moment they touch a
   * remote, and a browser will not start unmuted without a gesture anyway. Any
   * input unmutes, so the sound follows when the viewer is actually there.
   */
  muteOnOpen: true,

  /**
   * Cap on stream quality: 'auto', '1080', '720' or '480'.
   *
   * 720p by default. It is the point where the picture stops getting obviously
   * better and the bandwidth keeps going up, and a launcher on a home network
   * should not spend the evening pulling 4K nobody asked for.
   */
  maxQuality: '720',

  /**
   * Preferred audio language, as a comma-separated preference order.
   *
   * English first, then nothing: a channel broadcasting in one language should
   * be left in it unless there is a choice and the viewer has an opinion. A hard
   * default of English would quietly pick the English track on a channel whose
   * only other audio is Arabic, which is worse than not choosing.
   */
  audioLanguage: 'en',

  /**
   * Subtitles: 'off', 'on' or 'auto'. Off by default -- most of these channels
   * carry none, and a toggle nobody has ever turned on is clutter.
   */
  subtitles: 'off',

  /** Subtitle size in px, when subtitles are on. */
  subtitleSize: 22,

  /* ----------------------------- blocking ----------------------------- */

  /**
   * The master switch for the whole filter set.
   *
   * On, because it is the app's reason for existing. It is also killable, which
   * matters more than it sounds: an over-filtered page that will not load leaves
   * no way to tell whether the site is broken or the app is.
   */
  adBlocking: true,

  /**
   * Element hiding -- the CSS that removes ad overlays.
   *
   * Separately switchable from the master switch, and this is the one to reach
   * for first when a page will not click properly. A network block removes a
   * request; a cosmetic rule hides an element the page's own scripts still
   * expect to find, and over-hiding can take a control away with the ad.
   */
  hideInPageAds: true,

  /**
   * Hosts never to block, whoever asks. The escape hatch for one site without
   * giving up protection everywhere else.
   */
  blockingExceptions: [],
};

/** How often the automatic check may run, in ms. `null` means never. */
const CHECK_INTERVALS = {
  launch: null, // handled separately: once, at startup
  weekly: 7 * 24 * 60 * 60 * 1000,
  never: null,
};

function readRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8'));
    // A file containing `null` or a bare array parses without throwing but has no
    // keys on it. Spreading that would throw further down, where the stack no
    // longer points at the bad file.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Coerce one value, falling back to the default rather than trusting the file. */
function coerce(key, value) {
  const fallback = DEFAULTS[key];

  if (typeof fallback === 'boolean') return typeof value === 'boolean' ? value : fallback;

  if (Array.isArray(fallback)) {
    if (!Array.isArray(value)) return fallback.slice();
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean)
      .slice(0, 200);
  }

  if (key === 'deadDays') {
    const n = Number(value);
    // Clamped, not validated: a settings file is edited by hand more often than
    // anyone would admit, and 0 days would hide a channel the instant it failed
    // once, which is the exact failure this setting exists to prevent.
    if (!Number.isFinite(n)) return fallback;
    return Math.min(365, Math.max(1, Math.round(n)));
  }

  if (key === 'subtitleSize') {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(72, Math.max(10, Math.round(n)));
  }

  if (key === 'checkSchedule') {
    return Object.hasOwn(CHECK_INTERVALS, value) ? value : fallback;
  }

  if (key === 'maxQuality') {
    return ['auto', '1080', '720', '480'].includes(value) ? value : fallback;
  }

  if (key === 'subtitles') {
    return ['off', 'on', 'auto'].includes(value) ? value : fallback;
  }

  if (typeof fallback === 'string') return typeof value === 'string' ? value : fallback;
  return fallback;
}

/** Every setting, with defaults filled in for anything missing or corrupt. */
function all() {
  const raw = readRaw();
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = coerce(key, raw[key]);
  return out;
}

/** One setting. Never undefined, whatever is on disk. */
function get(key) {
  if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`unknown setting: ${key}`);
  return all()[key];
}

/**
 * Write a partial set of changes.
 *
 * Merged over what is already there rather than replacing the file, so a
 * settings screen that saves one field cannot blank out the rest -- which is
 * what happens the moment two screens both save.
 */
function set(changes = {}) {
  const next = { ...all() };
  for (const [key, value] of Object.entries(changes)) {
    if (!Object.hasOwn(DEFAULTS, key)) continue;
    next[key] = coerce(key, value);
  }
  fs.mkdirSync(paths.appDir(), { recursive: true });
  fs.writeFileSync(paths.settingsFile(), `${JSON.stringify(next, null, 1)}\n`);
  return next;
}

function reset() {
  fs.mkdirSync(paths.appDir(), { recursive: true });
  fs.writeFileSync(paths.settingsFile(), `${JSON.stringify(DEFAULTS, null, 1)}\n`);
  return { ...DEFAULTS };
}

/* ---------------------------- derived helpers --------------------------- */

/** Whether a genre is shown on the TV page. */
function genreVisible(genre, settings = all()) {
  if (!settings.hiddenGenres.length) return true;
  return !settings.hiddenGenres.includes(String(genre).toLowerCase());
}

/** Whether a channel's country passes the region filter. */
function countryVisible(country, settings = all()) {
  if (!settings.region.length) return true;
  if (!country) return false;
  return settings.region.includes(String(country).toUpperCase());
}

/** The highest level hls.js may auto-select, or -1 for no cap. */
function levelCap(settings = all()) {
  if (settings.maxQuality === 'auto') return -1;
  return Number(settings.maxQuality);
}

/** The audio languages to prefer, best first. */
function audioLanguages(settings = all()) {
  const seen = new Set();
  const out = [];
  for (const raw of String(settings.audioLanguage || '').split(',')) {
    const code = raw.trim().toLowerCase();
    // A repeated language is a preference written twice, not a second choice.
    // Left in, it makes the player search the same track list twice for nothing.
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/** Whether this host has been exempted from blocking. */
function isExempt(hostname, settings = all()) {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase().replace(/^www\./, '');
  const exceptions = Array.isArray(settings.blockingExceptions) ? settings.blockingExceptions : [];
  return exceptions.some((entry) => {
    const wanted = String(entry).toLowerCase().replace(/^www\./, '');
    if (!wanted) return false;
    // "example.com" covers example.com and everything under it, which is what
    // somebody means when they exempt a site. Matching on the suffix alone would
    // let "notexample.com" in, so the dot is required.
    return host === wanted || host.endsWith(`.${wanted}`);
  });
}

module.exports = {
  DEFAULTS,
  CHECK_INTERVALS,
  all,
  get,
  set,
  reset,
  genreVisible,
  countryVisible,
  levelCap,
  audioLanguages,
  isExempt,
};