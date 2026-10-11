'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Adding, filing and removing channels.
 *
 * The rule that matters most: an import refreshes the researched list and must
 * not delete a stream somebody found themselves. That is why added channels
 * live in the same file, marked, rather than somewhere a re-import could wipe.
 */

const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlauncher-edit-'));
process.env.XDG_DATA_HOME = dataHome;

const channels = require('../src/channels');

const MASTER_A = 'https://master.test/a.m3u8';
const MASTER_B = 'https://master.test/b.m3u8';

test.after(() => {
  fs.rmSync(dataHome, { recursive: true, force: true });
});

test.before(() => {
  channels.writeAll([
    { name: 'Alpha', genre: 'news', url: MASTER_A },
    { name: 'Beta', genre: 'sports', url: MASTER_B },
  ]);
});

test('an imported channel is marked as coming from the master list', () => {
  assert.strictEqual(channels.findByUrl(MASTER_A).source, 'master');
});

test('a channel added by hand lands in the new-channel pile', () => {
  const result = channels.add({ name: 'My Stream', url: 'https://mine.test/live.m3u8' });
  assert.ok(result.ok, JSON.stringify(result));
  assert.strictEqual(result.channel.genre, channels.NEW_GENRE);
  assert.strictEqual(result.channel.source, 'added');
});

test('new channel sorts to the top of the grid', () => {
  const grouped = channels.grouped();
  assert.strictEqual(grouped[0].genre, channels.NEW_GENRE);
});

test('a channel can be filed under a real genre', () => {
  const result = channels.update('https://mine.test/live.m3u8', { genre: 'Documentary' });
  assert.ok(result.ok);
  // Genre is stored lower-cased so one genre cannot appear twice with a case
  // variant, which would print two headings for the same thing.
  assert.strictEqual(result.channel.genre, 'documentary');
  assert.strictEqual(result.channel.source, 'added', 'filing must not change where it came from');
});

test('a channel added twice by the same link is refused', () => {
  const result = channels.add({ name: 'Clash', url: 'https://mine.test/live.m3u8' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /already/i);
});

test('a link that is not a usable stream is refused', () => {
  for (const url of ['', 'not a url', 'file:///etc/passwd', 'javascript:alert(1)', 'https://nodots/']) {
    const result = channels.add({ name: 'Bad', url });
    assert.strictEqual(result.ok, false, `accepted ${JSON.stringify(url)}`);
  }
});

test('a channel with no name is refused', () => {
  assert.strictEqual(channels.add({ name: '  ', url: 'https://ok.test/a.m3u8' }).ok, false);
});

test('editing the link moves the channel and drops its old health record', () => {
  channels.recordResult(MASTER_B, { ok: false, reason: 'gone' });
  assert.strictEqual(channels.findByUrl(MASTER_B).fails, 1);

  const result = channels.update(MASTER_B, { url: 'https://master.test/b-new.m3u8' });
  assert.ok(result.ok);
  assert.strictEqual(channels.findByUrl(MASTER_B), null, 'the old address should be gone');
  assert.strictEqual(channels.findByUrl('https://master.test/b-new.m3u8').fails, 0);
});

test('two channels cannot be given the same link', () => {
  // Seeded here rather than relying on an earlier test's list: an import partway
  // through this file replaces the master channels, and a test that assumed they
  // were still present would be testing its own history, not the store.
  channels.writeAll([
    { name: 'One', genre: 'news', url: 'https://dup.test/one.m3u8' },
    { name: 'Two', genre: 'news', url: 'https://dup.test/two.m3u8' },
  ]);
  const result = channels.update('https://dup.test/one.m3u8', { url: 'https://dup.test/two.m3u8' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /already uses/i);
});

test('an import keeps the channels added by hand', () => {
  const added = 'https://mine.test/keepme.m3u8';
  channels.add({ name: 'Keep Me', url: added });

  channels.writeAll([
    { name: 'Alpha', genre: 'news', url: MASTER_A },
    { name: 'Gamma', genre: 'news', url: 'https://master.test/c.m3u8' },
  ]);

  const kept = channels.findByUrl(added);
  assert.ok(kept, 'a hand-added channel was destroyed by a re-import');
  assert.strictEqual(kept.source, 'added');
  assert.strictEqual(channels.findByUrl(MASTER_B), null, 'a master channel should be replaced');
});

test('an import does not duplicate a channel it shares with the added pile', () => {
  const added = channels.findByUrl('https://mine.test/keepme.m3u8');
  channels.writeAll([{ name: 'Keep Me', genre: 'news', url: added.url }]);
  const matches = channels.all().filter((c) => c.url === added.url);
  assert.strictEqual(matches.length, 1);
});

test('removing a channel takes it out of the list and its history', () => {
  const url = 'https://mine.test/temporary.m3u8';
  channels.add({ name: 'Temporary', url });
  channels.recordResult(url, { ok: false, reason: 'gone' });

  const result = channels.remove(url);
  assert.ok(result.ok);
  assert.strictEqual(channels.findByUrl(url), null);
  // The record is dropped with it, so the URL is not left hiding something.
  assert.strictEqual(channels.readHealth()[url], undefined);
});

test('removing something that is not there says so rather than failing quietly', () => {
  const result = channels.remove('https://not.test/here.m3u8');
  assert.strictEqual(result.ok, false);
});

test('the hidden list holds exactly what is hidden', () => {
  const dead = 'https://hidden.test/dead.m3u8';
  const alive = 'https://hidden.test/alive.m3u8';
  channels.writeAll([
    { name: 'Dead One', genre: 'news', url: dead },
    { name: 'Live One', genre: 'news', url: alive },
  ]);

  for (let i = 0; i < 3; i += 1) {
    channels.recordResult(dead, { ok: false, reason: 'gone' });
  }

  const hidden = channels.hidden();
  assert.strictEqual(hidden.length, 1);
  assert.strictEqual(hidden[0].url, dead);

  channels.restore(dead);
  assert.strictEqual(channels.hidden().length, 0);
  assert.ok(channels.available().some((c) => c.url === dead));
});