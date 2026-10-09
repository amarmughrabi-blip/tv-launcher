'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const brave = require('../src/brave');

test('launchArgs carries the profile, fullscreen and the url', () => {
  const args = brave.launchArgs('https://example.com/', { profile: '/tmp/p' });

  assert.deepStrictEqual(args.slice(0, 2), ['--user-data-dir', '/tmp/p']);
  assert.ok(args.includes('--start-fullscreen'), 'opens fullscreen');
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.includes('--no-default-browser-check'));
  assert.strictEqual(args[args.length - 1], 'https://example.com/', 'url comes last');
});

test('a flatpak profile lives where the sandbox can actually write', () => {
  // A flatpak mounts $HOME read-only, so a profile under XDG_DATA_HOME would
  // never persist. It has to sit inside the app's own .var/app directory.
  const dir = brave.profileDir({ kind: 'flatpak', id: 'com.brave.Browser' }, '/data/root');
  assert.ok(dir.startsWith(path.join(process.env.HOME || '', '.var', 'app')));
  assert.ok(dir.endsWith('adblock-launcher-profile'));
});

test('a native profile lives beside the app data', () => {
  assert.strictEqual(
    brave.profileDir({ kind: 'native' }, '/data/root'),
    path.join('/data/root', 'brave-profile'),
  );
});

test('detect returns a usable shape or null, never a bad reference', () => {
  const d = brave.detect();
  if (d === null) return; // no browser installed; nothing to assert
  assert.ok(d.command && typeof d.command === 'string');
  assert.ok(Array.isArray(d.args));
  assert.ok(['native', 'flatpak'].includes(d.kind));
});

test('open refuses rather than throwing when no browser exists', () => {
  // Without patching fs this exercises the real code path on a machine that has
  // no browser at all; either outcome is acceptable, an exception is not.
  let result;
  try {
    result = brave.open('https://example.com/', { dataRoot: '/tmp/does-not-exist', log: () => {} });
  } catch (err) {
    assert.fail(`open threw: ${err.message}`);
  }
  assert.ok(result === null || typeof result.pid === 'number');
});