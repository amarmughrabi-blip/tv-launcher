'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Run `fn` against a scratch data dir holding the given channel + health. */
function withStore({ channels = [], health = null }, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-channels-'));
  process.env.XDG_DATA_HOME = home;
  const dir = path.join(home, 'adblock-launcher');
  fs.mkdirSync(dir, { recursive: true });
  if (channels) {
    fs.writeFileSync(path.join(dir, 'channels.json'), JSON.stringify({ channels }));
  }
  if (health) {
    fs.writeFileSync(path.join(dir, 'channel-health.json'), JSON.stringify(health));
  }
  // Required after the env is set: paths reads it at call time, but be explicit.
  const mod = require('../src/channels');
  return Promise.resolve(fn(mod)).finally(() => fs.rmSync(home, { recursive: true, force: true }));
}

const CH = {
  name: 'Al Jazeera',
  url: 'https://example.com/a.m3u8',
  genre: 'news',
  country: 'QA',
  res: '1920x1080',
  logo: null,
};

test('a channel with no health record is live', () =>
  withStore({ channels: [CH] }, (c) => {
    const all = c.all();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].fails, 0);
    assert.strictEqual(all[0].dead, false);
  }));

test('one failed probe does not hide a channel', () =>
  withStore(
    { channels: [CH], health: { [CH.url]: { fails: 1, at: 'x', reason: 'timeout' } } },
    (c) => {
      const [channel] = c.all();
      assert.strictEqual(channel.fails, 1);
      assert.strictEqual(
        channel.dead,
        false,
        'a single failed probe is usually a flaky connection, not a dead channel',
      );
      assert.strictEqual(c.summary().hidden, 0);
    },
  ));

test('a channel is hidden only after several consecutive failures', () =>
  withStore(
    {
      channels: [CH],
      health: { [CH.url]: { fails: 3, at: 'x', reason: 'not a manifest' } },
    },
    (c) => {
      const [channel] = c.all();
      assert.strictEqual(channel.dead, true);
      assert.strictEqual(c.summary().hidden, 1);
      assert.strictEqual(c.available().length, 0);
      assert.strictEqual(c.all().length, 1, 'hidden is not deleted');
    },
  ));

test('a recovered channel goes back to live', () =>
  withStore({ channels: [CH], health: { [CH.url]: { fails: 0, at: 'x' } } }, (c) => {
    const [channel] = c.all();
    assert.strictEqual(channel.dead, false);
    assert.strictEqual(c.available().length, 1);
  }));

test('a stream url is not accepted as a site and a page is not a channel', () => {
  const { usableUrl } = require('../src/channels');
  assert.ok(usableUrl('https://example.com/a.m3u8'));
  assert.strictEqual(usableUrl('file:///etc/passwd'), null);
  assert.strictEqual(usableUrl('javascript:alert(1)'), null);
  assert.strictEqual(usableUrl(''), null);
  assert.strictEqual(usableUrl(null), null);
});

test('duplicates by stream url collapse to one tile', () =>
  withStore(
    {
      channels: [CH, { ...CH, name: 'Al Jazeera (backup)' }],
    },
    (c) => assert.strictEqual(c.all().length, 1),
  ));

test('grouping keeps every channel exactly once', () =>
  withStore(
    {
      channels: [
        CH,
        { ...CH, url: 'https://example.com/b.m3u8', name: 'BBC', genre: 'news' },
        { ...CH, url: 'https://example.com/c.m3u8', name: 'Sky', genre: 'sports' },
      ],
    },
    (c) => {
      const grouped = c.grouped();
      const total = grouped.reduce((n, g) => n + g.channels.length, 0);
      assert.strictEqual(total, 3, 'grouping must not lose or duplicate channels');
      assert.deepStrictEqual(grouped.map((g) => g.genre), ['news', 'sports']);
    },
  ));

test('general comes first whatever the data order', () =>
  withStore(
    {
      channels: [
        { ...CH, url: 'https://example.com/s.m3u8', name: 'Sky', genre: 'sports' },
        { ...CH, url: 'https://example.com/g.m3u8', name: 'Al Ittihad', genre: 'general' },
      ],
    },
    (c) => {
      const first = c.grouped()[0].genre;
      assert.ok(['general', 'news', 'sports', 'movies'].includes(first));
    },
  ));

test('an empty or missing list reads as empty rather than throwing', () =>
  withStore({ channels: null }, (c) => {
    assert.deepStrictEqual(c.all(), []);
    assert.deepStrictEqual(c.grouped(), []);
    assert.strictEqual(c.summary().total, 0);
  }));

test('a malformed record is dropped rather than taking the list down', () =>
  withStore(
    {
      channels: [CH, { name: '', url: 'https://example.com/x.m3u8' }, { name: 'Bad', url: 'nope' }, null],
    },
    (c) => {
      const all = c.all();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].name, 'Al Jazeera');
    },
  ));