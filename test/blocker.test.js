'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { FiltersEngine, Request } = require('@ghostery/adblocker');
const { Blocker } = require('../src/blocker');

/** Build a request the way Electron hands them to onBeforeRequest. */
function req(url, type = 'other') {
  return Request.fromRawDetails({ url, type, requestId: '1', tabId: -1, sourceUrl: url });
}

/** Hosts the bundled lists demonstrably cover, verified by the assertions below. */
const BLOCKED = [
  ['https://www.google-analytics.com/analytics.js', 'script'],
  ['https://ad.doubleclick.net/ddm/ad.js', 'script'],
];

let blocker;

test.before(async () => {
  blocker = new Blocker({ log: () => {} });
  await blocker.load();
});

test('engine loads with a usable filter set', () => {
  assert.ok(blocker.ready, 'engine should be ready');
  assert.ok(
    blocker.engine.getFilters().networkFilters.length > 10_000,
    'expected a substantial prebuilt filter set',
  );
});

test('blocks known advertising hosts', () => {
  for (const [url, type] of BLOCKED) {
    assert.strictEqual(blocker.decide(req(url, type)).cancel, true, `should block ${url}`);
  }
});

test('never blocks top-level navigation', () => {
  for (const url of ['https://example.com/', 'https://news.ycombinator.com/']) {
    assert.strictEqual(blocker.decide(req(url, 'mainFrame')).cancel, false, `must allow ${url}`);
  }
});

test('allows ordinary site resources', () => {
  for (const [url, type] of [
    ['https://example.com/style.css', 'stylesheet'],
    ['https://example.com/app.js', 'script'],
    ['https://example.com/hero.png', 'image'],
  ]) {
    assert.strictEqual(blocker.decide(req(url, type)).cancel, false, `must allow ${url}`);
  }
});

test('an exception rule beats the block rule, and only for its own host', () => {
  // Built from an explicit list so the block/exception pairing is unambiguous.
  const engine = FiltersEngine.parse(
    ['||ads.test^', '||tracker.test^', '@@||good.ads.test^'].join('\n'),
    { loadNetworkFilters: true, loadExceptionFilters: true },
  );
  const b = new Blocker({ log: () => {} });
  b.engine = engine;

  assert.strictEqual(b.decide(req('https://ads.test/x.js', 'script')).cancel, true, 'blocked host');
  assert.strictEqual(
    b.decide(req('https://tracker.test/y.js', 'script')).cancel,
    true,
    'second blocked host',
  );
  assert.strictEqual(
    b.decide(req('https://good.ads.test/z.js', 'script')).cancel,
    false,
    'exception must allow its own host',
  );
  assert.strictEqual(
    b.decide(req('https://unrelated.test/w.js', 'script')).cancel,
    false,
    'unlisted host allowed',
  );
});

test('decide is safe before the engine is loaded', () => {
  const fresh = new Blocker({ log: () => {} });
  assert.strictEqual(fresh.ready, false);
  assert.deepStrictEqual(fresh.decide(req('https://example.com/x.js', 'script')), {
    cancel: false,
    matched: null,
  });
});

test('stats separate blocked from allowed', () => {
  const b = new Blocker({ log: () => {} });
  b.engine = blocker.engine;
  b.decide(req(BLOCKED[0][0], BLOCKED[0][1]));
  b.decide(req('https://example.com/', 'mainFrame'));
  assert.strictEqual(b.summary.blocked, 1);
  assert.strictEqual(b.summary.allowed, 1);
});