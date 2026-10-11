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
 */

const https = require('node:https');
const http = require('node:http');
const { reasonFor } = require('./channel-health');

const TIMEOUT_MS = 8000;
const HEAD_BYTES = 4096;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function probe(url, redirects = 0) {
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
          probe(next, redirects + 1).then(resolve);
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
          // The head of a manifest is enough; pulling every segment reference
          // would be a lot of traffic for no extra signal.
          if (body.length >= HEAD_BYTES) {
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('error', () => resolve({ ok: false, reason: 'reset' }));

        function finish() {
          if (!body.startsWith('#EXTM3U')) {
            resolve({ ok: false, body: 'not a manifest' });
            return;
          }
          if (!/#EXTINF/.test(body)) {
            // A valid manifest with no segments is a channel that has gone quiet.
            resolve({ ok: false, body: 'no segments' });
            return;
          }
          resolve({ ok: true });
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

/** Turn a raw probe result into a health reason. */
function classify(result) {
  if (result.ok) return 'ok';
  return reasonFor({
    code: result.code,
    status: result.status,
    body: result.body,
  });
}

module.exports = { probe, classify, TIMEOUT_MS };