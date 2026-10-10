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

/**
 * Bumped whenever the selection policy changes, so icons chosen under an older
 * policy are re-fetched instead of being served forever. This matters because a
 * cached icon keeps whatever resolution it was fetched at, however large it is
 * later drawn: a 16x16 stays mushy in a 72px circle no matter the CSS.
 *
 *   v2 - prefer the largest declared icon over the first one
 *   v3 - try declared icons before /favicon.ico
 */
const CACHE_POLICY = 'v3';

function cacheKey(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return crypto
    .createHash('sha1')
    .update(`${CACHE_POLICY}:${host}`)
    .digest('hex')
    .slice(0, 16);
}

function cacheFile(key) {
  return path.join(paths.cacheDir(), `${CACHE_POLICY}-${key}.ico`);
}

/**
 * Drop cache entries written under an older selection policy.
 *
 * Their filenames no longer carry the current prefix, so they can never be
 * read again; leaving them would grow the cache a little on every policy bump.
 * Only the favicon cache is touched -- user-picked icons live elsewhere.
 */
function pruneCache() {
  let names;
  try {
    names = fs.readdirSync(paths.cacheDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.ico')) continue;
    if (name.startsWith(`${CACHE_POLICY}-`)) continue;
    try {
      fs.rmSync(path.join(paths.cacheDir(), name), { force: true });
    } catch {
      /* best effort */
    }
  }
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

/** Largest integer size declared by an icon link's `sizes` attribute. */
function declaredSize(tag) {
  const sizes = (tag.match(/sizes=["']([^"']+)["']/i) || [])[1] || '';
  const parts = sizes.match(/(\d+)[xX](\d+)/);
  if (parts) return Math.min(Number(parts[1]), Number(parts[2]));
  const any = sizes.match(/(\d+)/);
  return any ? Number(any[1]) : 0;
}

/**
 * Icon candidates for a page, best first.
 *
 * `apple-touch-icon` is preferred over the page icon because it is almost
 * always a crisp 180px PNG, where the declared icon is frequently a 16px one
 * that turns to mush when scaled up into a 72px circle.
 */
function candidates(html, base) {
  const tags = [...String(html || '').matchAll(/<link[^>]+>/gi)].map((m) => m[0]);
  const found = [];

  for (const tag of tags) {
    const rel = (tag.match(/rel=["']([^"']+)["']/i) || [])[1] || '';
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href || !rel) continue;
    const apple = /apple-touch-icon/i.test(rel);
    if (!apple && !/(^|\s)icon(\s|$)/i.test(rel)) continue;
    let url;
    try {
      url = new URL(href, base).toString();
    } catch {
      continue;
    }
    found.push({ url, size: declaredSize(tag), apple });
  }

  found.sort((a, b) => {
    if (a.apple !== b.apple) return a.apple ? -1 : 1;
    return b.size - a.size;
  });

  const seen = new Set();
  const out = [];
  for (const c of found) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c.url);
  }
  return out;
}

async function fetchIcon(url, { net, log = () => {} } = {}) {
  const key = cacheKey(url);
  if (!key) return null;

  const onDisk = cached(url);
  if (onDisk) return onDisk;

  const origins = [];
  try {
    const u = new URL(url);
    try {
      const res = await net.fetch(u.toString(), {
        redirect: 'follow',
        signal: timeoutSignal(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const html = await res.text();
        // Declared icons go first. /favicon.ico is last, not first: it is
        // frequently a 16x16 ICO, and taking it in preference to a declared
        // 144x144 is what made icons look like blurry squares in a 72px circle.
        origins.push(...candidates(html, u.toString()));
      }
    } catch {
      /* the /favicon.ico fallback below is enough */
    }
    origins.push(`${u.origin}/favicon.ico`);
  } catch {
    return null;
  }

  for (const candidate of origins) {
    try {
      const res = await net.fetch(candidate, { signal: timeoutSignal(FETCH_TIMEOUT_MS) });
      if (!res.ok) continue;
      // Many sites answer /favicon.ico with an HTML page. Caching that produces
      // a broken image, so require an actual image content type.
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (!type.startsWith('image/')) continue;
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

module.exports = { fetchIcon, cached, cacheKey, candidates, declaredSize, cacheFile, pruneCache };