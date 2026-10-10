'use strict';

/**
 * Profiles and site storage.
 *
 * A profile is a named set of sites. Exactly one is active, and the CRUD
 * helpers below act on it, so callers do not have to thread a profile id
 * through every call.
 *
 * On disk:
 *   profiles.json  { "active": "<id>", "profiles": [ { id, name, sites } ] }
 *
 * The older sites.json (a bare array of records, or of URL strings) is read
 * once on first run and folded into a default profile, then left untouched as a
 * backup.
 */

const fs = require('node:fs');
const path = require('node:path');
const { paths } = require('./paths');

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
const DEFAULT_PROFILE_ID = 'default';
const DEFAULT_PROFILE_NAME = 'My apps';

const PROFILE_NAME_MAX = 40;

/* --------------------------------- urls -------------------------------- */

function normaliseUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  let candidate = text;
  if (!SCHEME_RE.test(candidate)) candidate = `https://${candidate}`;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname.includes('.')) return null;

  return url.toString();
}

/** Strip a leading www. so labels read the way people say them. */
function defaultLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function makeRecord(url, label, icon) {
  return { url, label: label || defaultLabel(url), icon: icon || null };
}

/** Accept a record or a bare string; reject anything else. */
function coerce(item) {
  if (typeof item === 'string') {
    const url = normaliseUrl(item);
    return url ? makeRecord(url) : null;
  }
  if (item && typeof item === 'object' && typeof item.url === 'string') {
    const url = normaliseUrl(item.url);
    if (!url) return null;
    return makeRecord(url, item.label, item.icon);
  }
  return null;
}

function recordsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((r, i) => {
    const o = b[i];
    return r.url === o.url && r.label === o.label && (r.icon || null) === (o.icon || null);
  });
}

/* ------------------------------- profiles ------------------------------ */

function sanitiseName(name, fallback) {
  const text = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return fallback;
  return text.slice(0, PROFILE_NAME_MAX);
}

function makeProfile(name, id, sites) {
  return {
    id: id || DEFAULT_PROFILE_ID,
    name: sanitiseName(name, DEFAULT_PROFILE_NAME),
    sites: Array.isArray(sites) ? sites.map(coerce).filter(Boolean) : [],
  };
}

/** Build the initial profile list from whatever is already on disk. */
function initialState() {
  // First run: fold a pre-profiles sites.json in, so nothing is lost.
  let legacy = null;
  try {
    legacy = JSON.parse(fs.readFileSync(paths.sitesFile(), 'utf8'));
  } catch {
    legacy = null;
  }

  const seed = Array.isArray(legacy) ? legacy.map(coerce).filter(Boolean) : [];
  return {
    active: DEFAULT_PROFILE_ID,
    profiles: [makeProfile(DEFAULT_PROFILE_NAME, DEFAULT_PROFILE_ID, seed)],
  };
}

/** Canonical shape, used for both writing and change detection. */
function canonicalise(state) {
  return {
    active: state.active,
    profiles: state.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      sites: p.sites.map((s) => ({ url: s.url, label: s.label, icon: s.icon || null })),
    })),
  };
}

/**
 * Read the profile file, normalising and persisting it once when it differs.
 *
 * Persisting here is what makes migration stick: without it the legacy shapes
 * would be re-upgraded on every single load, forever.
 */
function readState() {
  const file = paths.profilesFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return writeState(initialState());
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Corrupt file: keep a copy and carry on rather than refusing to start.
    try {
      fs.writeFileSync(`${file}.corrupt-${Date.now()}`, raw, 'utf8');
    } catch {
      /* best effort */
    }
    return writeState(initialState());
  }

  if (!data || !Array.isArray(data.profiles) || data.profiles.length === 0) {
    return writeState(initialState());
  }

  const profiles = data.profiles
    .filter((p) => p && typeof p.id === 'string')
    .map((p, i) => makeProfile(p.name, p.id || `p${i}`, Array.isArray(p.sites) ? p.sites : []));
  if (!profiles.length) return writeState(initialState());

  const active = profiles.some((p) => p.id === data.active) ? data.active : profiles[0].id;
  const state = { active, profiles };

  const canonical = `${JSON.stringify(canonicalise(state), null, 2)}\n`;
  if (canonical !== raw) writeState(state);
  return state;
}

function writeState(state) {
  fs.mkdirSync(paths.appDir(), { recursive: true });
  const ordered = {
    active: state.active,
    profiles: state.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      sites: p.sites,
    })),
  };
  fs.writeFileSync(paths.profilesFile(), `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
  return ordered;
}

function nextProfileId(state) {
  const taken = new Set(state.profiles.map((p) => p.id));
  let n = state.profiles.length + 1;
  while (taken.has(`p${n}`)) n += 1;
  return `p${n}`;
}

function activeProfile(state = readState()) {
  return state.profiles.find((p) => p.id === state.active) || state.profiles[0];
}

/* ---------------------------- profile actions -------------------------- */

function listProfiles() {
  const state = readState();
  return {
    active: state.active,
    profiles: state.profiles.map((p) => ({ id: p.id, name: p.name, count: p.sites.length })),
  };
}

function createProfile(name) {
  const state = readState();
  const id = nextProfileId(state);
  state.profiles.push(makeProfile(name || `Profile ${state.profiles.length + 1}`, id, []));
  state.active = id;
  writeState(state);
  return listProfiles();
}

function renameProfile(id, name) {
  const state = readState();
  const profile = state.profiles.find((p) => p.id === id);
  if (!profile) return listProfiles();
  profile.name = sanitiseName(name, profile.name);
  return writeState(state) && listProfiles();
}

/** Delete a profile. The last one is kept, so there is always somewhere to go. */
function deleteProfile(id) {
  const state = readState();
  if (state.profiles.length <= 1) return listProfiles();

  const index = state.profiles.findIndex((p) => p.id === id);
  if (index < 0) return listProfiles();

  const [removed] = state.profiles.splice(index, 1);
  for (const site of removed.sites) {
    // Only drop the icon if no other profile is still using it.
    const stillUsed = state.profiles.some((p) => p.sites.some((s) => s.icon === site.icon));
    if (site.icon && !stillUsed) deleteIcon(site.icon);
  }
  if (state.active === id) state.active = state.profiles[0].id;
  return writeState(state) && listProfiles();
}

function setActiveProfile(id) {
  const state = readState();
  if (!state.profiles.some((p) => p.id === id)) return listProfiles();
  state.active = id;
  return writeState(state) && listProfiles();
}

/* ------------------------------ site CRUD ------------------------------ */

/** Records in the active profile. */
function load() {
  return activeProfile().sites;
}

function save(records) {
  const state = readState();
  const profile = activeProfile(state);
  profile.sites = (Array.isArray(records) ? records : []).map(coerce).filter(Boolean);
  writeState(state);
  return profile.sites;
}

function find(records, url) {
  return records.find((r) => r.url === url) || null;
}

function add(url, label, icon) {
  const records = load();
  const normalised = normaliseUrl(url);
  if (!normalised) return records;
  if (find(records, normalised)) return records; // adding an existing site is a no-op

  records.push(makeRecord(normalised, label, icon));
  records.sort((a, b) =>
    (a.label || '').toLowerCase().localeCompare((b.label || '').toLowerCase()),
  );
  return save(records);
}

function remove(url) {
  const records = load();
  const target = find(records, url);
  const kept = records.filter((r) => r.url !== url);
  if (target && target.icon) deleteIcon(target.icon);
  return save(kept);
}

function update(url, fields = {}) {
  const records = load();
  const record = find(records, url);
  if (!record) return records;

  if ('label' in fields) {
    const label = typeof fields.label === 'string' ? fields.label.trim() : '';
    record.label = label || defaultLabel(record.url);
  }
  if ('icon' in fields) {
    const next = fields.icon || null;
    if (record.icon && record.icon !== next) deleteIcon(record.icon);
    record.icon = next;
  }
  return save(records);
}

function reorder(url, direction) {
  const records = load();
  const index = records.findIndex((r) => r.url === url);
  if (index < 0) return records;
  const target = index + direction;
  if (target < 0 || target >= records.length) return records;
  [records[index], records[target]] = [records[target], records[index]];
  return save(records);
}

function deleteIcon(name) {
  // Synchronous on purpose: removal is not on a hot path, and a caller that
  // deletes a site and then checks the icon store must not race us.
  if (!name || !/^[a-f0-9]+\.png$/.test(name)) return;
  fs.rmSync(path.join(paths.iconsDir(), name), { force: true });
}

module.exports = {
  // profiles
  listProfiles,
  createProfile,
  renameProfile,
  deleteProfile,
  setActiveProfile,
  activeProfile,
  // sites in the active profile
  normaliseUrl,
  defaultLabel,
  coerce,
  load,
  save,
  find,
  add,
  remove,
  update,
  reorder,
  deleteIcon,
  // internals, for tests
  _internal: {
    recordsEqual,
    makeRecord,
    makeProfile,
    sanitiseName,
    initialState,
    readState,
    writeState,
    DEFAULT_PROFILE_ID,
    DEFAULT_PROFILE_NAME,
  },
};