'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * The recording rules, exercised against a real store rather than a stub.
 *
 * The behaviour that matters is the split between hard and soft failures. A
 * timeout must never move a channel closer to being hidden, because geo-blocking
 * and a bad network both arrive as timeouts, and hiding those would take away
 * channels that work fine for someone else.
 */

const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlauncher-health-'));
process.env.XDG_DATA_HOME = dataHome;

const channels = require('../src/channels');
const { paths } = require('../src/paths');

const URL_A = 'https://example.test/a/stream.m3u8';
const URL_B = 'https://example.test/b/stream.m3u8';
const URL_C = 'https://example.test/c/stream.m3u8';
const URL_D = 'https://example.test/d/stream.m3u8';
const URL_E = 'https://example.test/e/stream.m3u8';
const URL_F = 'https://example.test/f/stream.m3u8';
const URL_G = 'https://example.test/g/stream.m3u8';

test.before(() => {
  channels.writeAll([
    { name: 'Alpha', genre: 'news', url: URL_A },
    { name: 'Beta', genre: 'news', url: URL_B },
    { name: 'Gamma', genre: 'news', url: URL_C },
    { name: 'Delta', genre: 'news', url: URL_D },
    { name: 'Epsilon', genre: 'news', url: URL_E },
    { name: 'Zeta', genre: 'news', url: URL_F },
    { name: 'Eta', genre: 'news', url: URL_G },
  ]);
});

test.after(() => {
  fs.rmSync(dataHome, { recursive: true, force: true });
});

test('a hard failure moves the channel one step closer to being hidden', () => {
  const first = channels.recordResult(URL_A, { ok: false, reason: 'gone' });
  assert.strictEqual(first.counted, true);
  assert.strictEqual(first.fails, 1);
  assert.strictEqual(first.hidden, false);
});

test('failing all in one evening does not hide the channel', () => {
  // Three failures, all on the same day. That is a bad network, not a dead
  // channel, and the day-based rule is what stops it costing anything.
  for (let i = 0; i < 3; i += 1) {
    const outcome = channels.recordResult(URL_B, { ok: false, reason: 'dns' });
    assert.strictEqual(outcome.hidden, false);
  }
  assert.strictEqual(channels.findByUrl(URL_B).fails, 3, 'the attempts are still counted');
  assert.strictEqual(channels.findByUrl(URL_B).streak, 1, 'but it is one day');
  assert.strictEqual(channels.findByUrl(URL_B).dead, false);
});

test('enough days in a row hides the channel', () => {
  // Seeded with a run of days rather than a run of attempts: the only way to
  // test a day-based rule without waiting a week is to write the history.
  const state = channels.readHealth();
  state[URL_B] = {
    fails: 7,
    days: Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - i);
      return channels.dayKey(d);
    }),
    at: new Date().toISOString(),
    reason: 'dns',
  };
  channels.writeHealth(state);

  assert.strictEqual(channels.findByUrl(URL_B).dead, true);
  assert.ok(!channels.available().some((c) => c.url === URL_B));
});

test('a timeout costs nothing, however many times it happens', () => {
  for (let i = 0; i < 6; i += 1) {
    const outcome = channels.recordResult(URL_C, { ok: false, reason: 'timeout' });
    assert.strictEqual(outcome.counted, false, 'a timeout must never count');
  }
  const channel = channels.findByUrl(URL_C);
  assert.strictEqual(channel.fails, 0);
  assert.strictEqual(channel.dead, false);
  // It is still recorded, so the player can explain what happened.
  assert.strictEqual(channel.checked !== null, true);
});

test('a geo-block is recorded but does not hide the channel', () => {
  const outcome = channels.recordResult(URL_D, { ok: false, reason: 'blocked' });
  assert.strictEqual(outcome.counted, false);
  assert.strictEqual(channels.findByUrl(URL_D).dead, false);
});

test('a channel that plays clears its run of failures', () => {
  channels.recordResult(URL_F, { ok: false, reason: 'gone' });
  channels.recordResult(URL_F, { ok: false, reason: 'gone' });
  assert.strictEqual(channels.findByUrl(URL_F).fails, 2);

  const good = channels.recordResult(URL_F, { ok: true });
  assert.strictEqual(good.fails, 0);
  assert.strictEqual(channels.findByUrl(URL_F).fails, 0);
  assert.strictEqual(channels.findByUrl(URL_F).dead, false);
});

test('a soft failure does not reset a hard run', () => {
  channels.recordResult(URL_E, { ok: false, reason: 'gone' });
  channels.recordResult(URL_E, { ok: false, reason: 'timeout' });
  assert.strictEqual(channels.findByUrl(URL_E).fails, 1, 'the run must survive a timeout');
});

test('restore brings a hidden channel back and clears its history', () => {
  const state = channels.readHealth();
  state[URL_B] = {
    fails: 9,
    days: Array.from({ length: 9 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - i);
      return channels.dayKey(d);
    }),
    at: new Date().toISOString(),
    reason: 'dns',
  };
  channels.writeHealth(state);
  assert.strictEqual(channels.findByUrl(URL_B).dead, true);

  channels.restore(URL_B);
  const back = channels.findByUrl(URL_B);
  assert.strictEqual(back.dead, false);
  assert.strictEqual(back.fails, 0);
  assert.ok(channels.available().some((c) => c.url === URL_B));
});

test('hide takes a channel off the grid at once, by hand', () => {
  channels.hide(URL_E);
  assert.strictEqual(channels.findByUrl(URL_E).dead, true);
  channels.restore(URL_E);
  assert.strictEqual(channels.findByUrl(URL_E).dead, false);
});

test('the master list is never rewritten by a health result', () => {
  const before = fs.readFileSync(paths.channelsFile(), 'utf8');
  channels.recordResult(URL_A, { ok: false, reason: 'gone' });
  channels.hide(URL_C);
  assert.strictEqual(fs.readFileSync(paths.channelsFile(), 'utf8'), before);
});

test('a healthy channel is not rewritten every time it stalls', () => {
  // `playing` fires again after every stall, and a live stream can do that
  // constantly. Rewriting the file each time is churn for no change at all.
  channels.recordResult(URL_G, { ok: true });

  const before = fs.statSync(paths.channelHealthFile()).mtimeMs;
  const outcome = channels.recordResult(URL_G, { ok: true });
  assert.strictEqual(outcome.fails, 0);
  const after = fs.statSync(paths.channelHealthFile()).mtimeMs;
  assert.strictEqual(after, before, 'a settled channel should not be rewritten');
});