'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { FiltersEngine, Request } = require('@ghostery/adblocker');
const { Blocker } = require('../src/blocker');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
// --- cosmetic (element-hiding) filtering -------------------------------------
//
// The ads that cause the reported symptom are not requests at all: they are
// markup in the page, delivered as transparent overlays stacked on top of the
// content. Network blocking cannot touch them, so cosmetic filtering is the
// only thing that removes them.

test('cosmeticsFor returns CSS, not an empty list', () => {
  const b = new Blocker({ log: () => {} });
  b.engine = {
    getCosmeticsFilters: () => ({ styles: '.ad-slot { display: none !important; }', scripts: [] }),
  };
  const out = b.cosmeticsFor('https://example.com/watch');
  assert.match(out.styles, /ad-slot/);
});

test('cosmeticsFor passes the hostname through, dropping a www prefix', () => {
  let seen = null;
  const b = new Blocker({ log: () => {} });
  b.engine = {
    getCosmeticsFilters: (opts) => {
      seen = opts;
      return { styles: '', scripts: [] };
    },
  };
  b.cosmeticsFor('https://www.example.com/watch');
  assert.strictEqual(seen.hostname, 'www.example.com');
  assert.strictEqual(seen.domain, 'example.com');
  assert.strictEqual(seen.url, 'https://www.example.com/watch');
});

test('cosmeticsFor is inert without an engine or a usable URL', () => {
  const fresh = new Blocker({ log: () => {} });
  assert.deepStrictEqual(fresh.cosmeticsFor('https://example.com/'), { styles: '', scripts: [] });

  const b = new Blocker({ log: () => {} });
  b.engine = { getCosmeticsFilters: () => ({ styles: 'x' }) };
  assert.deepStrictEqual(b.cosmeticsFor('not a url'), { styles: '', scripts: [] });
});

test('cosmeticsFor survives a throwing engine', () => {
  const b = new Blocker({ log: () => {} });
  b.engine = {
    getCosmeticsFilters: () => {
      throw new Error('boom');
    },
  };
  assert.deepStrictEqual(b.cosmeticsFor('https://example.com/'), { styles: '', scripts: [] });
});

test('the engine is built with cosmetic filtering enabled', () => {
  // enableHtmlFiltering defaults to false, and getCosmeticsFilters is a no-op
  // without it -- the engine would parse tens of thousands of element-hiding
  // rules and then discard every one of them.
  const src = require('node:fs').readFileSync(require.resolve('../src/blocker'), 'utf8');
  assert.match(src, /enableHtmlFiltering:\s*true/);
});

test('cosmetics come from getCosmeticsFilters, not the empty getHtmlFilters bucket', () => {
  // getHtmlFilters reads a bucket the engine leaves unpopulated and returns
  // nothing at all, silently. Using it looks like it works and hides nothing.
  const src = require('node:fs').readFileSync(require.resolve('../src/blocker'), 'utf8');
  // Comments may name the wrong API to explain why it is wrong; code may not.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /getCosmeticsFilters/);
  assert.doesNotMatch(code, /getHtmlFilters/);
});

/* --------------------------- the switches --------------------------- */

/**
 * The settings that can turn blocking off.
 *
 * The kill switch is the important one. An over-filtered page that will not load
 * gives the viewer no way to tell a broken site from a broken app, so there has
 * to be one control that stops all of it -- and it has to stop *everything*,
 * immediately, rather than the rules that had already been decided.
 */

function blockingBlocker(overrides = {}) {
  const b = new Blocker({
    log: () => {},
    settings: () => ({ adBlocking: true, hideInPageAds: true, blockingExceptions: [], ...overrides }),
  });
  return b;
}

test('the master switch stops every block, immediately', async () => {
  const on = blockingBlocker();
  await on.load();
  assert.strictEqual(on.decide(req('https://ad.doubleclick.net/ddm/ad.js', 'script')).cancel, true);

  const off = blockingBlocker({ adBlocking: false });
  await off.load();
  assert.strictEqual(off.decide(req('https://ad.doubleclick.net/ddm/ad.js', 'script')).cancel, false);
  // Re-read every call, so flipping the switch does not need a restart.
  let live = true;
  const dynamic = new Blocker({ log: () => {}, settings: () => ({ adBlocking: live, hideInPageAds: true, blockingExceptions: [] }) });
  await dynamic.load();
  assert.strictEqual(dynamic.decide(req('https://ad.doubleclick.net/ddm/ad.js', 'script')).cancel, true);
  live = false; // master switch off, mid-session
  assert.strictEqual(dynamic.decide(req('https://ad.doubleclick.net/ddm/ad.js', 'script')).cancel, false);
});

test('a per-site exception unblocks that site and no other', async () => {
  const b = blockingBlocker({ blockingExceptions: ['doubleclick.net'] });
  await b.load();
  assert.strictEqual(b.decide(req('https://ad.doubleclick.net/ddm/ad.js', 'script')).cancel, false);
  assert.strictEqual(
    b.decide(req('https://www.google-analytics.com/analytics.js', 'script')).cancel,
    true,
    'a second site must stay blocked',
  );
});

test('an exception covers subdomains, and not a lookalike host', async () => {
  const b = blockingBlocker({ blockingExceptions: ['google-analytics.com'] });
  await b.load();

  // Subdomains of an exempted host are exempted.
  assert.strictEqual(b.decide(req('https://www.google-analytics.com/analytics.js', 'script')).cancel, false);

  // A host that merely ends with the same letters is not. Asserted on the
  // exemption rather than on the outcome: whether the bundled lists happen to
  // carry a rule for an invented domain says nothing about exemptions, and
  // asserting on the outcome would silently test list coverage instead.
  assert.strictEqual(b.isExempt('notgoogle-analytics.com'), false);
  assert.strictEqual(b.isExempt('google-analytics.com.evil.net'), false);
  assert.strictEqual(b.isExempt('google-analytics.com'), true);
  assert.strictEqual(b.isExempt('www.google-analytics.com'), true);

  // And a genuinely different blocked host is untouched.
  assert.strictEqual(b.decide(req('https://ad.doubleclick.net/ddm/ad.js', 'script')).cancel, true);
});

test('element hiding is separately switchable from blocking the network', async () => {
  const b = blockingBlocker({ hideInPageAds: false });
  await b.load();
  assert.strictEqual(
    b.decide(req('https://ad.doubleclick.net/ddm/ad.js', 'script')).cancel,
    true,
    'network blocking is unaffected by the cosmetic switch',
  );
  const { styles } = b.cosmeticsFor('https://example.com/');
  assert.strictEqual(styles, '', 'no CSS is injected when element hiding is off');
});

test('an exempted site gets no element hiding either', async () => {
  const b = blockingBlocker({ blockingExceptions: ['example.com'] });
  await b.load();
  assert.strictEqual(b.cosmeticsFor('https://example.com/page').styles, '');
});

test('the summary says whether blocking is on, and counts exemptions apart', async () => {
  const b = blockingBlocker({ blockingExceptions: ['doubleclick.net'] });
  await b.load();
  b.decide(req('https://ad.doubleclick.net/ddm/ad.js', 'script'));
  b.decide(req('https://www.google-analytics.com/analytics.js', 'script'));
  const s = b.summary;
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.exempted, 1);
  assert.strictEqual(s.blocked, 1);
  assert.strictEqual(s.allowed, 1);
});

/* ------------------------------ the cache ------------------------------ */

/**
 * The engine is cached between launches.
 *
 * Parsing takes about four seconds and blocks the main process for the whole of
 * it; reading the serialised form back takes a fraction of that. So the cache is
 * the difference between a launcher that is up immediately and one that sits on
 * a loading screen -- which is why it is worth being this careful about.
 *
 * The failure it must not have is quietly fewer rules than a fresh parse: every
 * ad that comes back is one the viewer sees.
 */

function withCacheHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-blocker-cache-'));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = home;
  return Promise.resolve(fn(home))
    .finally(() => {
      if (previous === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    });
}

test('the engine is cached and restored, with every rule intact', async () => {
  await withCacheHome(async (home) => {
    const first = new Blocker({ log: () => {}, settings: () => ({ adBlocking: true, hideInPageAds: true, blockingExceptions: [] }) });
    await first.load();

    const cacheDir = path.join(home, 'adblock-launcher', 'cache');
    assert.ok(
      fs.existsSync(path.join(cacheDir, 'blocker-engine.bin')),
      'the first run must leave a cache behind',
    );

    const second = new Blocker({ log: () => {}, settings: () => ({ adBlocking: true, hideInPageAds: true, blockingExceptions: [] }) });
    await second.load();

    const a = first.engine.getFilters();
    const b = second.engine.getFilters();
    assert.strictEqual(b.networkFilters.length, a.networkFilters.length, 'fewer network filters after a round trip');
    assert.strictEqual(b.cosmeticFilters.length, a.cosmeticFilters.length, 'fewer cosmetic rules after a round trip');

    // The restored engine has to actually work, not merely exist.
    assert.strictEqual(
      second.decide(req('https://ad.doubleclick.net/ddm/ad.js', 'script')).cancel,
      true,
      'a restored engine that does not block is worse than no engine',
    );
  });
});

test('a cache from a different build is thrown away rather than trusted', async () => {
  await withCacheHome(async (home) => {
    const b = new Blocker({ log: () => {}, settings: () => ({ adBlocking: true, hideInPageAds: true, blockingExceptions: [] }) });
    await b.load();
    const stampPath = path.join(home, 'adblock-launcher', 'cache', 'blocker-engine.stamp');
    fs.writeFileSync(stampPath, '0.0.0-someone-elses-build\n');

    const messages = [];
    const c = new Blocker({
      log: (m) => messages.push(m),
      settings: () => ({ adBlocking: true, hideInPageAds: true, blockingExceptions: [] }),
    });
    await c.load();
    assert.ok(
      messages.some((m) => /different build/.test(m)),
      'a stale cache must be rebuilt, not used',
    );
    assert.ok(c.ready);
  });
});

test('a corrupt cache falls back to parsing instead of failing', async () => {
  await withCacheHome(async (home) => {
    const cacheDir = path.join(home, 'adblock-launcher', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'blocker-engine.bin'), 'not a serialised engine');
    fs.writeFileSync(path.join(cacheDir, 'blocker-engine.stamp'), 'x\n');

    const b = new Blocker({ log: () => {}, settings: () => ({ adBlocking: true, hideInPageAds: true, blockingExceptions: [] }) });
    await b.load();
    assert.ok(b.ready, 'a bad cache must not stop the app having any blocking at all');
  });
});

test('several callers asking at once share one parse', async () => {
  await withCacheHome(async () => {
    const b = new Blocker({ log: () => {}, settings: () => ({ adBlocking: true, hideInPageAds: true, blockingExceptions: [] }) });
    const started = Date.now();
    // Opening a site during a cold start asks for the engine while startup is
    // still asking for it. Without sharing, that is a second four-second parse
    // on top of the first.
    await Promise.all([b.load(), b.load(), b.load()]);
    assert.ok(b.ready);
    assert.strictEqual(b.loading !== null, true, 'the shared load must be recorded');
    assert.ok(Date.now() - started < 30_000, 'sanity: it did finish');
    assert.strictEqual(
      b.decide(req('https://ad.doubleclick.net/ddm/ad.js', 'script')).cancel,
      true,
      'and the engine it settled on still blocks',
    );
  });
});

test('ensureReady gives up rather than waiting for ever', async () => {
  await withCacheHome(async () => {
    const b = new Blocker({ log: () => {}, settings: () => ({ adBlocking: true, hideInPageAds: true, blockingExceptions: [] }) });
    // A load that never settles: the whole point of taking the parse off the
    // startup path is that nothing is left waiting on it without an end.
    b.loading = new Promise(() => {});
    const started = Date.now();
    const ready = await b.ensureReady(200);
    assert.strictEqual(ready, false);
    assert.ok(Date.now() - started < 2000, 'it waited past its own limit');
  });
});
