'use strict';

/**
 * Favicon fetching.
 *
 * Prefers the site's own declared icon and falls back to /favicon.ico. Results
 * are cached on disk keyed by host so the grid paints without a network round
 * trip on every launch, and a failure is cached too, briefly, so a site with no
 * icon does not delay every render.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { paths } = require('./paths');

const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ICON_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 4000;

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  return undefined;
}

function cacheKey(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return crypto.createHash('sha1').update(host).digest('hex').slice(0, 16);
}

function cacheFile(key) {
  return path.join(paths.cacheDir(), `${key}.ico`);
}

/** Cached icon path, or null. Expired negative entries report as null. */
function cached(url) {
  const key = cacheKey(url);
  if (!key) return null;
  const file = cacheFile(key);
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0 && Date.now() - stat.mtimeMs > NEGATIVE_TTL_MS) {
      fs.rmSync(file, { force: true });
      return null;
    }
    return file;
  } catch {
    return null;
  }
}

/** Extract <link rel="icon"> from the page HTML, if it declares one. */
function declaredIcon(html, base) {
  const re = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i;
  const tag = (html.match(re) || [])[0];
  if (!tag) return null;
  const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

async function fetchIcon(url, { net, log = () => {} } = {}) {
  const key = cacheKey(url);
  if (!key) return null;

  const onDisk = cached(url);
  if (onDisk) return onDisk;

  const origins = [];
  try {
    const u = new URL(url);
    origins.push(`${u.origin}/favicon.ico`);
    try {
      const res = await net.fetch(u.toString(), {
        redirect: 'follow',
        signal: timeoutSignal(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const html = await res.text();
        const declared = declaredIcon(html, u.toString());
        if (declared && declared !== origins[0]) origins.push(declared);
      }
    } catch {
      /* the /favicon.ico attempt below is enough */
    }
  } catch {
    return null;
  }

  for (const candidate of origins) {
    try {
      const res = await net.fetch(candidate, { signal: timeoutSignal(FETCH_TIMEOUT_MS) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_ICON_BYTES) continue;
      fs.mkdirSync(paths.cacheDir(), { recursive: true });
      const file = cacheFile(key);
      fs.writeFileSync(file, buf);
      return file;
    } catch {
      /* try the next candidate */
    }
  }

  // Remember the miss so a site with no icon does not stall every later render.
  try {
    fs.mkdirSync(paths.cacheDir(), { recursive: true });
    fs.writeFileSync(cacheFile(key), '');
  } catch {
    /* best effort */
  }
  log(`no favicon for ${url}`);
  return null;
}

module.exports = { fetchIcon, cached, cacheKey, declaredIcon, cacheFile };