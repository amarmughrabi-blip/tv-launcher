'use strict';

/**
 * Channel health.
 *
 * Free streams rot. Roughly 44% of a community playlist was already dead when
 * it was last checked, so a list that is only ever added to slowly fills with
 * tiles that go nowhere.
 *
 *   node scripts/check-channels.js [--concurrency N] [--reset] [--quiet]
 *
 * Two rules, both deliberate:
 *
 *  - A channel is dropped only after several *consecutive* failed probes. One
 *    failure is far more likely to be a flaky connection than a channel that has
 *    gone, and dropping on the first would empty the grid over an afternoon.
 *  - The master list is never rewritten. Results go to channel-health.json and
 *    are merged at read time, so re-probing cannot damage the researched list.
 *
 * A probe fetches the manifest and checks it parses as HLS with at least one
 * segment. That is cheap and catches the common failures: the host is gone, the
 * path 404s, or the response is an HTML error page.
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');
const channels = require('../src/channels');
const { paths } = require('../src/paths');
const fs = require('node:fs');

const DEFAULT_CONCURRENCY = 12;
const PROBE_TIMEOUT_MS = 8000;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

/** A manifest that is really HLS, not an HTML page that happens to return 200. */
async function probe(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'unparseable url' };
  }

  return new Promise((resolve) => {
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(
      url,
      { timeout: PROBE_TIMEOUT_MS, headers: { 'User-Agent': USER_AGENT } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          probe(new URL(res.headers.location, url).toString()).then(resolve);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ ok: false, reason: `http ${res.statusCode}` });
          return;
        }

        let body = '';
        // A manifest header is enough; pulling the whole playlist would mean
        // downloading every segment reference for no extra signal.
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 4096) {
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('error', () => resolve({ ok: false, reason: 'read error' }));

        function finish() {
          if (!body.startsWith('#EXTM3U')) {
            resolve({ ok: false, reason: 'not a manifest' });
            return;
          }
          if (!/#EXTINF/.test(body)) {
            // A manifest with no segments is a channel that has gone quiet.
            resolve({ ok: false, reason: 'no segments' });
            return;
          }
          resolve({ ok: true });
        }
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'timeout' });
    });
    req.on('error', (err) => resolve({ ok: false, reason: err.code || err.message }));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const concurrency = Number(
    argv[argv.indexOf('--concurrency') + 1] || DEFAULT_CONCURRENCY,
  ) || DEFAULT_CONCURRENCY;
  const reset = argv.includes('--reset');
  const quiet = argv.includes('--quiet');

  const list = channels.all();
  if (!list.length) {
    console.error('no channels imported — run scripts/import-channels.js first');
    return 1;
  }

  const healthPath = paths.channelHealthFile();
  let health = {};
  if (!reset) {
    try {
      health = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
    } catch {
      health = {};
    }
  }

  console.log(`probing ${list.length} channels, ${concurrency} at a time`);
  const at = new Date().toISOString();
  let done = 0;
  let newlyDead = 0;
  let recovered = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const channel = list[cursor];
      cursor += 1;
      const result = await probe(channel.url);

      const previous = health[channel.url] || { fails: 0 };
      if (result.ok) {
        if (previous.fails > 0) recovered += 1;
        health[channel.url] = { fails: 0, at, reason: null };
      } else {
        const fails = (previous.fails || 0) + 1;
        const wasDead = previous.fails >= channels.FAILURES_BEFORE_DROP;
        health[channel.url] = { fails, at, reason: result.reason };
        if (!wasDead && fails >= channels.FAILURES_BEFORE_DROP) newlyDead += 1;
      }

      done += 1;
      if (!quiet && done % 25 === 0) process.stdout.write(`  ${done}/${list.length}\n`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  fs.mkdirSync(paths.appDir(), { recursive: true });
  fs.writeFileSync(healthPath, `${JSON.stringify(health, null, 1)}\n`);

  const s = channels.summary();
  console.log('');
  console.log(`probed ${done} channels`);
  console.log(`live ${s.live} / hidden ${s.hidden} of ${s.total}`);
  console.log(`newly hidden ${newlyDead}, recovered ${recovered}`);
  console.log(`written to ${healthPath}`);
  console.log('');
  console.log(`a channel is hidden after ${channels.FAILURES_BEFORE_DROP} consecutive failures`);
  console.log('--reset forgets the history and starts counting again');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });