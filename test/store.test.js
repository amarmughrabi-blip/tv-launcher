'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Point XDG_DATA_HOME at a scratch dir so the real profile is never touched. */
function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlauncher-'));
  process.env.XDG_DATA_HOME = home;
  return Promise.resolve(fn(home)).finally(() => fs.rmSync(home, { recursive: true, force: true }));
}

function writeSites(home, contents) {
  const dir = path.join(home, 'adblock-launcher');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sites.json'), contents, 'utf8');
}

function readSites(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'adblock-launcher', 'sites.json'), 'utf8'));
}

// store reads paths at call time, so it can be required before XDG_DATA_HOME moves.
const store = require('../src/store');

test('normaliseUrl', async () => {
  await withTempHome(async () => {
    assert.strictEqual(store.normaliseUrl('example.com'), 'https://example.com/');
    assert.strictEqual(store.normaliseUrl('https://example.com/x'), 'https://example.com/x');
    assert.strictEqual(store.normaliseUrl('  http://a.example  '), 'http://a.example/');
    assert.strictEqual(store.normaliseUrl(''), null);
    assert.strictEqual(store.normaliseUrl('localhost'), null, 'hostless input rejected');
    assert.strictEqual(store.normaliseUrl('ftp://example.com'), null, 'non-http scheme rejected');
    assert.strictEqual(store.normaliseUrl(null), null);
  });
});

test('defaultLabel strips a leading www', async () => {
  await withTempHome(async () => {
    assert.strictEqual(store.defaultLabel('https://www.example.com/'), 'example.com');
    assert.strictEqual(store.defaultLabel('https://sub.example.com/'), 'sub.example.com');
  });
});

test('a bare URL array migrates to records and is written back once', async () => {
  await withTempHome(async (home) => {
    writeSites(home, JSON.stringify(['https://a.example', 'https://b.example']));

    const records = store.load();
    assert.strictEqual(records.length, 2);
    assert.deepStrictEqual(records[0], { url: 'https://a.example/', label: 'a.example', icon: null });

    // The upgrade must be persisted, otherwise it repeats on every load.
    const onDisk = readSites(home);
    assert.ok(Array.isArray(onDisk));
    assert.strictEqual(typeof onDisk[0], 'object', 'file must hold records, not strings');

    // A second load must be a no-op, not a rewrite.
    const before = fs.statSync(path.join(home, 'adblock-launcher', 'sites.json')).mtimeMs;
    store.load();
    const after = fs.statSync(path.join(home, 'adblock-launcher', 'sites.json')).mtimeMs;
    assert.strictEqual(before, after, 'stable format must not be rewritten');
  });
});

test('records already in the new shape load unchanged', async () => {
  await withTempHome(async (home) => {
    const records = [{ url: 'https://a.example/', label: 'Custom', icon: 'abc123abc123.png' }];
    writeSites(home, JSON.stringify(records));
    assert.deepStrictEqual(store.load(), records);
  });
});

test('a corrupt file is preserved and does not throw', async () => {
  await withTempHome(async (home) => {
    writeSites(home, '{ this is not json');
    assert.deepStrictEqual(store.load(), [], 'must degrade to an empty list');

    const dir = path.join(home, 'adblock-launcher');
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    assert.strictEqual(backups.length, 1, 'corrupt content should be kept for inspection');
  });
});

test('add, remove, and the no-op duplicate case', async () => {
  await withTempHome(async () => {
    let records = store.add('example.com');
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].label, 'example.com');

    records = store.add('https://example.com/');
    assert.strictEqual(records.length, 1, 'adding the same site again must be a no-op');

    records = store.add('other.example', 'Other');
    assert.strictEqual(records.length, 2);
    assert.deepStrictEqual(
      records.map((r) => r.label),
      ['example.com', 'Other'],
      'records sort by label, case-insensitively',
    );

    records = store.remove('https://other.example/');
    assert.strictEqual(records.length, 1);
  });
});

test('update rewrites label and icon', async () => {
  await withTempHome(async () => {
    store.add('example.com');
    store.update('https://example.com/', { label: 'My Site' });
    assert.strictEqual(store.load()[0].label, 'My Site');

    store.update('https://example.com/', { label: '   ' });
    assert.strictEqual(store.load()[0].label, 'example.com', 'blank label falls back to host');

    store.update('https://example.com/', { icon: 'aaaaaaaaaaaa.png' });
    assert.strictEqual(store.load()[0].icon, 'aaaaaaaaaaaa.png');
  });
});

test('reorder moves one slot and clamps at the ends', async () => {
  await withTempHome(async () => {
    store.add('a.example', 'A');
    store.add('b.example', 'B');
    store.add('c.example', 'C');

    let records = store.reorder('https://c.example/', -1);
    assert.deepStrictEqual(records.map((r) => r.label), ['A', 'C', 'B']);

    records = store.reorder('https://a.example/', -1);
    assert.deepStrictEqual(records.map((r) => r.label), ['A', 'C', 'B'], 'no move past the start');

    records = store.reorder('https://b.example/', 1);
    assert.deepStrictEqual(records.map((r) => r.label), ['A', 'C', 'B'], 'no move past the end');
  });
});

test('removing a site deletes its stored icon', async () => {
  await withTempHome(async () => {
    const { paths } = require('../src/paths');
    paths.ensure();
    fs.writeFileSync(path.join(paths.iconsDir(), 'aaaaaaaaaaaa.png'), 'x');

    store.add('example.com', 'Example', 'aaaaaaaaaaaa.png');
    assert.ok(fs.existsSync(path.join(paths.iconsDir(), 'aaaaaaaaaaaa.png')), 'precondition');

    store.remove('https://example.com/');
    assert.ok(!fs.existsSync(path.join(paths.iconsDir(), 'aaaaaaaaaaaa.png')));
  });
});