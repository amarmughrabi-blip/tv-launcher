'use strict';

/**
 * Site list persistence.
 *
 * The on-disk shape is an array of records: { url, label, icon }. A bare array
 * of URL strings is also accepted on read and upgraded in place, so a profile
 * written by an earlier revision keeps working. The upgrade is written back
 * immediately, which is what stops the migration running on every single load.
 */

const fs = require('node:fs');
const path = require('node:path');
const { paths } = require('./paths');

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
const DEFAULT_LABEL_RE = /^[a-zA-Z0-9 ()\-']{3,64}$/;

/**
 * Turn typed text into a launchable URL, or null if it cannot be one.
 * Adds https:// when no scheme is given and rejects hostless input.
 */
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

function load() {
  const file = paths.sitesFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return [];
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // A corrupt file must not take the app down. Keep a copy so it can be
    // inspected, and carry on with an empty list.
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.writeFileSync(backup, raw, 'utf8');
    } catch {
      /* best effort */
    }
    return [];
  }

  if (!Array.isArray(data)) return [];

  const records = data.map(coerce).filter(Boolean);
  // Only rewrite when the file genuinely differs from the upgraded shape, so
  // repeated loads are stable.
  if (!recordsEqual(records, data)) save(records);

  return records;
}

function save(records) {
  fs.mkdirSync(paths.appDir(), { recursive: true });
  fs.writeFileSync(paths.sitesFile(), `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  return records;
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
  records.sort((a, b) => (a.label || '').toLowerCase().localeCompare((b.label || '').toLowerCase()));
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
    // Replacing an icon discards the old file so the store does not grow.
    const next = fields.icon || null;
    if (record.icon && record.icon !== next) deleteIcon(record.icon);
    record.icon = next;
  }
  return save(records);
}

/** Move a record one slot left (-1) or right (+1). */
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
  if (!name || !/^[a-f0-9]+\.png$/.test(name)) return; // never unlink outside the store
  fs.rm(path.join(paths.iconsDir(), name), { force: true }, () => {});
}

module.exports = {
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
  // exported for tests
  _internal: { recordsEqual, makeRecord, SCHEME_RE, DEFAULT_LABEL_RE },
};