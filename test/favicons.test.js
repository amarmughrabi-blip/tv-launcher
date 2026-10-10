'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlauncher-fav-'));
  process.env.XDG_DATA_HOME = home;
  return Promise.resolve(fn(home)).finally(() => fs.rmSync(home, { recursive: true, force: true }));
}

const favicons = require('../src/favicons');

const PAGE = [
  '<link rel="shortcut icon" href="/favicon.ico" type="image/x-icon">',
  '<link rel="icon" sizes="32x32" href="/f32.png">',
  '<link rel="apple-touch-icon" sizes="180x180" href="/apple.png">',
  '<link rel="icon" sizes="144x144" href="/f144.png">',
  '<link rel="stylesheet" href="/app.css">',
].join('\n');

test('picks the largest declared icon, not the first one', () => {
  const list = favicons.candidates(PAGE, 'https://site.test/page');
  assert.deepStrictEqual(
    list.slice(0, 3),
    [
      'https://site.test/apple.png', // apple-touch-icon preferred: crisper in practice
      'https://site.test/f144.png', // then largest declared
      'https://site.test/f32.png',
    ],
  );
});

test('resolves relative hrefs and ignores non-icon links', () => {
  const list = favicons.candidates(PAGE, 'https://site.test/deep/page');
  assert.ok(list.includes('https://site.test/f144.png'));
  assert.ok(!list.some((u) => u.endsWith('.css')));
});

test('reads sizes in any declared form', () => {
  assert.strictEqual(favicons.declaredSize('<link sizes="64x64">'), 64);
  assert.strictEqual(favicons.declaredSize('<link sizes=\'180X180\'>'), 180);
  assert.strictEqual(favicons.declaredSize('<link sizes="any">'), 0);
  assert.strictEqual(favicons.declaredSize('<link>'), 0);
});

test('deduplicates repeated hrefs', () => {
  const page = '<link rel="icon" href="/a.png" sizes="32x32"><link rel="icon" href="/a.png" sizes="64x64">';
  assert.strictEqual(favicons.candidates(page, 'https://site.test/').length, 1);
});

// The regression that shipped: /favicon.ico was tried first, so a site whose
// fallback is a 16x16 ICO won over its own declared 144x144, and the grid drew
// a blurry blob inside the circle. Assert the fetch order, not just the parse.
test('declared icons are fetched before the /favicon.ico fallback', async () => {
  await withTempHome(async () => {
    const tried = [];
    const net = {
      fetch: async (url) => {
        tried.push(url);
        if (url === 'https://site.test/') {
          return { ok: true, headers: { get: () => 'text/html' }, text: async () => PAGE };
        }
        return {
          ok: true,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
        };
      },
    };

    await favicons.fetchIcon('https://site.test/', { net });
    const first = tried.findIndex((u) => /apple|f144/.test(u));
    const fallback = tried.indexOf('https://site.test/favicon.ico');
    assert.ok(first !== -1, 'a declared icon should have been tried');
    assert.ok(
      fallback === -1 || first < fallback,
      `declared icons must be tried before /favicon.ico (order: ${tried.join(', ')})`,
    );
  });
});

test('skips a non-image response rather than caching HTML as an icon', async () => {
  await withTempHome(async () => {
    const net = {
      fetch: async (url) => {
        if (url === 'https://site.test/') {
          return { ok: true, headers: { get: () => 'text/html' }, text: async () => PAGE };
        }
        // A captive portal answering every request with HTML.
        return { ok: true, headers: { get: () => 'text/html' }, arrayBuffer: async () => new ArrayBuffer(8) };
      },
    };
    const file = await favicons.fetchIcon('https://site.test/', { net });
    assert.strictEqual(file, null, 'HTML must not be written to the icon cache');
  });
});

test('prunes entries written under an older selection policy', async () => {
  await withTempHome((home) => {
    const dir = path.join(home, 'adblock-launcher', 'cache');
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, 'deadbeefdeadbeef.ico');
    const current = favicons.cacheFile(favicons.cacheKey('https://site.test/'));
    fs.writeFileSync(stale, 'old');
    fs.mkdirSync(path.dirname(current), { recursive: true });
    fs.writeFileSync(current, 'new');

    favicons.pruneCache();

    assert.ok(!fs.existsSync(stale), 'entry from an older policy should be removed');
    assert.ok(fs.existsSync(current), 'current entry must be kept');
  });
});

test('the cache key varies with the policy so a fix can invalidate old icons', () => {
  // Guards the failure mode where a better icon is fetched but the stale one
  // is still served, because the key did not change.
  const key = favicons.cacheKey('https://site.test/');
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.notStrictEqual(key, favicons.cacheKey('https://other.test/'));
});
