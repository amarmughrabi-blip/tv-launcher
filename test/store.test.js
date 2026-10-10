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

function writeProfiles(home, contents) {
  const dir = path.join(home, 'adblock-launcher');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'profiles.json'),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
    'utf8',
  );
}

function readProfiles(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'adblock-launcher', 'profiles.json'), 'utf8'));
}

function writeSites(home, contents) {
  const dir = path.join(home, 'adblock-launcher');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'sites.json'),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
    'utf8',
  );
}

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

test('a bare URL array migrates to records inside the default profile', async () => {
  await withTempHome(async (home) => {
    writeSites(home, JSON.stringify(['https://a.example', 'https://b.example']));

    const records = store.load();
    assert.strictEqual(records.length, 2);
    assert.deepStrictEqual(records[0], { url: 'https://a.example/', label: 'a.example', icon: null });

    const onDisk = readProfiles(home);
    assert.strictEqual(onDisk.profiles.length, 1);
    assert.ok(
      typeof onDisk.profiles[0].sites[0] === 'object',
      'sites must be records, not strings',
    );

    // The upgrade must be persisted, otherwise it repeats on every load.
    const before = fs.statSync(path.join(home, 'adblock-launcher', 'profiles.json')).mtimeMs;
    store.load();
    const after = fs.statSync(path.join(home, 'adblock-launcher', 'profiles.json')).mtimeMs;
    assert.strictEqual(before, after, 'stable format must not be rewritten');
  });
});

test('records already in the new shape load unchanged', async () => {
  await withTempHome(async (home) => {
    const sites = [{ url: 'https://a.example/', label: 'Custom', icon: 'abc123abc123.png' }];
    writeProfiles(home, {
      active: 'default',
      profiles: [{ id: 'default', name: 'My apps', sites }],
    });
    assert.deepStrictEqual(store.load(), sites);
  });
});

test('a corrupt profiles file is preserved and does not throw', async () => {
  await withTempHome(async (home) => {
    writeProfiles(home, '{ this is not json');
    assert.deepStrictEqual(store.load(), [], 'must degrade to an empty profile');

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

/* ----------------------------- profiles -------------------------------- */

test('a new install starts with one empty profile', async () => {
  await withTempHome(async () => {
    const listed = store.listProfiles();
    assert.strictEqual(listed.profiles.length, 1);
    assert.strictEqual(listed.active, listed.profiles[0].id);
    assert.strictEqual(listed.profiles[0].count, 0);
    assert.deepStrictEqual(store.load(), []);
  });
});

test('profiles keep separate sets of sites', async () => {
  await withTempHome(async () => {
    store.add('work.example', 'Work');

    store.createProfile('Streaming');
    assert.deepStrictEqual(store.load(), [], 'the new profile starts empty');

    store.add('cinebytv.com', 'Cineby');
    assert.strictEqual(store.load().length, 1);

    const ids = store.listProfiles().profiles.map((p) => p.id);
    store.setActiveProfile(ids[0]);

    const work = store.load();
    assert.strictEqual(work.length, 1);
    assert.strictEqual(work[0].label, 'Work', 'switching back must not show the other profile');

    store.setActiveProfile(ids[1]);
    assert.strictEqual(store.load()[0].label, 'Cineby');
  });
});

test('creating a profile makes it active and gives it a unique id', async () => {
  await withTempHome(async () => {
    store.createProfile('One');
    const second = store.createProfile('Two');
    assert.strictEqual(second.profiles.length, 3);
    assert.strictEqual(second.active, second.profiles[2].id, 'a new profile becomes active');
    assert.strictEqual(new Set(second.profiles.map((p) => p.id)).size, 3, 'ids must be unique');
  });
});

test('profile names are trimmed, collapsed and bounded', async () => {
  await withTempHome(async () => {
    store.createProfile('   spaced    out   ');
    let listed = store.listProfiles();
    assert.strictEqual(listed.profiles[1].name, 'spaced out');

    store.renameProfile(listed.profiles[1].id, 'x'.repeat(200));
    listed = store.listProfiles();
    assert.ok(listed.profiles[1].name.length <= 40, 'long names are bounded');

    store.renameProfile(listed.profiles[1].id, '   ');
    listed = store.listProfiles();
    assert.strictEqual(listed.profiles[1].name, 'x'.repeat(40), 'blank rename keeps the old name');
  });
});

test('deleting a profile moves to another one and the last is kept', async () => {
  await withTempHome(async () => {
    const a = store.createProfile('A');
    const aId = a.profiles[1].id;
    const b = store.createProfile('B');
    const bId = b.profiles[2].id;
    store.add('only.example', 'Only');

    let listed = store.deleteProfile(bId);
    assert.strictEqual(listed.profiles.length, 2);
    assert.ok(listed.profiles.some((p) => p.id !== bId), 'deleted profile is gone');

    listed = store.deleteProfile(aId);
    assert.strictEqual(listed.profiles.length, 1, 'the last profile is kept');
    assert.strictEqual(listed.profiles[0].id, listed.active);
    assert.ok(!listed.profiles.some((p) => p.id === aId) || listed.profiles.length === 1);
  });
});

test('deleting the active profile activates a surviving one', async () => {
  await withTempHome(async () => {
    store.createProfile('First');
    store.createProfile('Second');
    const activeId = store.listProfiles().active;
    const firstId = store.listProfiles().profiles[0].id;

    const listed = store.deleteProfile(activeId);
    assert.ok(listed.profiles.some((p) => p.id !== activeId), 'the deleted profile is gone');
    assert.strictEqual(listed.active, firstId, 'falls back to the first remaining profile');
    assert.ok(
      listed.profiles.some((p) => p.id === listed.active),
      'the active profile must exist',
    );
  });
});

test('an unknown profile id is refused rather than switching', async () => {
  await withTempHome(async () => {
    store.createProfile('Real');
    const before = store.listProfiles().active;
    const after = store.setActiveProfile('nope');
    assert.strictEqual(after.active, before);
    assert.strictEqual(store.renameProfile('nope', 'x').active, before);
  });
});

test('a profile file with a stale active id falls back to a real one', async () => {
  await withTempHome(async (home) => {
    writeProfiles(home, {
      active: 'vanished',
      profiles: [
        { id: 'a', name: 'A', sites: [] },
        { id: 'b', name: 'B', sites: [] },
      ],
    });
    const listed = store.listProfiles();
    assert.ok(listed.profiles.some((p) => p.id === listed.active), 'active must exist');
  });
});

test('a profile with sites in the legacy string shape is upgraded', async () => {
  await withTempHome(async (home) => {
    writeProfiles(home, {
      active: 'a',
      profiles: [{ id: 'a', name: 'A', sites: ['https://x.example', 'https://y.example'] }],
    });
    const records = store.load();
    assert.strictEqual(records.length, 2);
    assert.strictEqual(typeof records[0].url, 'string');
    assert.ok(records[0].label, 'legacy strings gain a label');

    const onDisk = readProfiles(home);
    assert.ok(typeof onDisk.profiles[0].sites[0] === 'object', 'upgrade written back');
  });
});