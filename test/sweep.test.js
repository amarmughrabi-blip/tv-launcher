'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Checking a batch of channels, and applying the answer afterwards.
 *
 * The behaviour worth protecting is that nothing is written until the result is
 * confirmed, and that a run which cannot tell the difference between a dead
 * channel and a bad network says so rather than hiding anything.
 */

const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlauncher-sweep-'));
process.env.XDG_DATA_HOME = dataHome;

const sweep = require('../src/sweep');
const channels = require('../src/channels');
const probe = require('../src/channel-probe');

const A = 'https://sweep.test/a.m3u8';
const B = 'https://sweep.test/b.m3u8';
const C = 'https://sweep.test/c.m3u8';
const D = 'https://sweep.test/d.m3u8';

test.after(() => {
  fs.rmSync(dataHome, { recursive: true, force: true });
});

/** Channels shaped like the store's output, with no network involved. */
const list = [
  { name: 'Checked And Fine', url: A, fails: 0, checked: '2026-01-01T00:00:00.000Z' },
  { name: 'Checked And Dead', url: B, fails: 2, checked: '2026-01-01T00:00:00.000Z' },
  { name: 'Never Checked', url: C, fails: 0, checked: null },
  { name: 'Never Checked Either', url: D, fails: 0, checked: null },
];

test('never-checked is the default, because those are the ones doing nothing', () => {
  assert.deepStrictEqual(sweep.select(list, 'unchecked').map((c) => c.name), [
    'Never Checked',
    'Never Checked Either',
  ]);
});

test('failed looks only at channels already in trouble', () => {
  assert.deepStrictEqual(sweep.select(list, 'failed').map((c) => c.name), ['Checked And Dead']);
});

test('all looks at everything', () => {
  assert.strictEqual(sweep.select(list, 'all').length, 4);
});

test('an unrecognised choice falls back rather than checking everything by accident', () => {
  // "all" costs 453 requests. A typo must not become that.
  assert.strictEqual(sweep.select(list, 'nonsense').length, 2);
});

test('a sweep writes nothing at all', async () => {
  channels.writeAll(list.map(({ name, url }) => ({ name, url, genre: 'news' })));
  const file = require('../src/paths').paths.channelHealthFile();
  // The file may not exist yet -- nothing has been recorded, which is the point.
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;

  await sweep.sweep([channels.findByUrl(B), channels.findByUrl(C)], { which: 'failed' });

  const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  assert.strictEqual(after, before, 'checking must not hide anything on its own');
});

/** The last `n` calendar days, as health records store them. */
const dayRun = (n) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    return channels.dayKey(d);
  });

test('applying only hides what has genuinely gone', () => {
  // The shape a sweep returns: hard failures count, soft ones do not.
  const report = {
    results: [
      { url: A, name: 'Fine', reason: 'ok', ok: true, counted: false, previousFails: 2, fails: 0, days: [] },
      {
        // The sweep builds `days` itself, including today, so the fixture carries
        // the whole run rather than the days before it.
        url: B, name: 'Gone', reason: 'dns', ok: false, counted: true,
        previousFails: 6, fails: 6, days: dayRun(7),
      },
      {
        url: C, name: 'Hung', reason: 'timeout', ok: false, counted: false,
        previousFails: 0, fails: 0, days: [],
      },
    ],
  };

  const { state, hidden } = sweep.apply(report, {});
  assert.strictEqual(state[A].fails, 0, 'a channel that answers clears its run');
  assert.deepStrictEqual(state[A].days, [], 'and its days are forgotten');
  assert.strictEqual(state[B].fails, 7);
  assert.strictEqual(hidden.length, 1, 'and it is reported as gone');
  assert.strictEqual(hidden[0].url, B);
  assert.strictEqual(state[C].fails, 0, 'a timeout must not move the counter');
  assert.strictEqual(state[C].reason, 'timeout', 'but it is still recorded, to be explained');
});

test('a soft failure does not reset a hard run either', () => {
  const report = {
    results: [
      {
        url: B, name: 'Gone', reason: 'timeout', ok: false, counted: false,
        previousFails: 2, fails: 2, days: [],
      },
    ],
  };
  const seeded = { [B]: { fails: 2, days: dayRun(2), at: 'x', reason: 'gone' } };
  const { state } = sweep.apply(report, seeded);
  // A channel genuinely failing all week that times out tonight is not thereby
  // healthy. Clearing its record would let a flaky network keep a dead stream on
  // the grid for ever.
  assert.strictEqual(state[B].fails, 2);
  assert.strictEqual(state[B].days.length, 2, 'the run survives the uncertain night');
});

test('a channel failing all in one evening is not hidden', () => {
  const report = {
    results: [
      {
        url: B, name: 'Busy Evening', reason: 'dns', ok: false, counted: true,
        previousFails: 0, fails: 0, days: [channels.dayKey(new Date())],
      },
    ],
  };
  const { hidden } = sweep.apply(report, {});
  assert.strictEqual(hidden.length, 0);
});

test('applying the same report twice cannot push a channel past the threshold', () => {
  const report = {
    results: [
      {
        url: B, name: 'Gone', reason: 'dns', ok: false, counted: true,
        previousFails: 6, fails: 6, days: dayRun(7),
      },
    ],
  };
  const first = sweep.apply(report, {});
  assert.strictEqual(first.hidden.length, 1);
  const second = sweep.apply(report, first.state);
  assert.strictEqual(
    channels.streakDays(second.state[B].days),
    7,
    'the same seven days applied twice is still seven days, not fourteen',
  );
});

/* ---------------------------- the deep probe ---------------------------- */

test('the first segment is found, and relative paths resolved', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXTINF:9.0,',
    'seg1.ts',
    '#EXTINF:9.0,',
    '/other/seg2.ts',
  ].join('\n');
  assert.strictEqual(
    probe.firstSegment(manifest, 'https://cdn.test/live/index.m3u8'),
    'https://cdn.test/live/seg1.ts',
  );
});

test('a manifest of nothing but comments has no segment', () => {
  assert.strictEqual(probe.firstSegment('#EXTM3U\n#EXT-X-ENDLIST', 'https://a.test/i.m3u8'), null);
});

test('the selected set is a copy, never the list it was given', () => {
  const original = list.slice();
  sweep.select(list, 'all');
  assert.deepStrictEqual(list, original);
});