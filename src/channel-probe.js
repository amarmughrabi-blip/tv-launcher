'use strict';

/**
 * Diagnostic probe: what is actually wrong with a channel?
 *
 * hls.js reports "network error" and stops there. That is not enough to decide
 * anything -- a missing host, a timeout and a geo-block all arrive as the same
 * event, and only the first means the channel is gone.
 *
 * So when playback fails, the channel is fetched directly from main, where the
 * real error is visible: DNS, a refused connection, a 404, or a body that turns
 * out to be an HTML page. That answer is used twice -- to decide whether the
 * channel counts towards being hidden, and to tell the viewer what happened.
 *
 * Two depths:
 *
 *   quick  the manifest only. Cheap, and catches everything except a manifest
 *          that parses perfectly while every segment behind it is gone.
 *   deep   the manifest and then the first segment. Slower and heavier, and the
 *          only way to be sure a channel that answers is actually watchable.
 */

const https = require('node:https');
const http = require('node:http');
const { reasonFor } = require('./channel-health');

const TIMEOUT_MS = 8000;
const HEAD_BYTES = 4096;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

/**
 * One HTTP GET, returning the head of the body.
 *
 * Deliberately not Node's fetch: this needs the underlying error code. Every
 * layer above this turns ENOTFOUND and ETIMEDOUT into an opaque "network
 * error", which is the exact distinction the health check turns on.
 */
function get(url, { redirects = 0 } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, reason: 'notManifest' });
      return;
    }

    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(
      url,
      { timeout: TIMEOUT_MS, headers: { 'User-Agent': USER_AGENT } },
      (res) => {
        const status = res.statusCode;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects >= 5) {
            resolve({ ok: false, reason: 'gone' });
            return;
          }
          let next = res.headers.location;
          try {
            next = new URL(next, url).toString();
          } catch {
            resolve({ ok: false, reason: 'gone' });
            return;
          }
          get(next, { redirects: redirects + 1 }).then(resolve);
          return;
        }

        if (status !== 200) {
          res.resume();
          resolve({ ok: false, status });
          return;
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          // The head is enough. Pulling every segment reference would be a lot
          // of traffic for no extra signal.
          if (body.length >= HEAD_BYTES) {
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('error', () => resolve({ ok: false, code: 'ECONNRESET' }));

        function finish() {
          resolve({ ok: true, body, url });
        }
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, code: 'ETIMEDOUT' });
    });
    req.on('error', (err) => resolve({ ok: false, code: err.code || null }));
  });
}

/** The first media segment named in a manifest, resolved against its own URL. */
function firstSegment(manifest, manifestUrl) {
  for (const line of manifest.split('\n')) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    try {
      return new URL(entry, manifestUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Check a stream.
 *
 * @param {string} url        the manifest address
 * @param {object} [options]
 * @param {boolean} [options.deep] also fetch the first segment
 */
async function probe(url, { deep = false } = {}) {
  const result = await get(url);
  if (!result.ok) return result;

  const body = result.body || '';
  if (!body.startsWith('#EXTM3U')) return { ok: false, body: 'not a manifest' };
  if (!/#EXTINF/.test(body)) {
    // A valid manifest with no segments is a channel that has gone quiet.
    return { ok: false, body: 'no segments' };
  }

  if (!deep) return { ok: true };

  const segment = firstSegment(body, result.url);
  if (!segment) return { ok: false, body: 'no segments' };

  const part = await get(segment);
  if (!part.ok) return { ok: false, stage: 'segment', ...part };
  if (!(part.body || '').length) return { ok: false, body: 'empty segment', stage: 'segment' };
  return { ok: true };
}

/** Turn a raw probe result into a health reason. */
function classify(result) {
  if (result.ok) return 'ok';
  return reasonFor({
    code: result.code,
    status: result.status,
    body: result.body,
  });
}

module.exports = { probe, classify, get, firstSegment, TIMEOUT_MS };