'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlauncher-icons-'));
  process.env.XDG_DATA_HOME = home;
  return Promise.resolve(fn(home)).finally(() => fs.rmSync(home, { recursive: true, force: true }));
}

const icons = require('../src/icons');

/** Stand-in for Electron's nativeImage, so the sizing logic is testable. */
function fakeCodec({ width = 100, height = 100, fail = false } = {}) {
  return {
    calls: [],
    decode(buf) {
      if (fail) throw new Error('unreadable');
      return {
        width,
        height,
        toPng(max) {
          this.max = max;
          iconsCalls.push(max);
          // Scale the way the real codec does, and report it back in the payload.
          const ratio = Math.min(1, max / width, max / height);
          const w = Math.max(1, Math.round(width * ratio));
          const h = Math.max(1, Math.round(height * ratio));
          return Buffer.from(`PNG ${w}x${h}`);
        },
      };
    },
  };
}

let iconsCalls = [];

function makeSource(home, name, contents = 'fake image bytes') {
  const file = path.join(home, name);
  fs.writeFileSync(file, contents);
  return file;
}

test.beforeEach(() => {
  iconsCalls = [];
});

test('icon names are stable, hash-shaped and filesystem safe', () => {
  const a = icons.iconName('/home/u/pictures/logo.png');
  assert.match(a, /^[a-f0-9]{12}\.png$/, 'must match the store name pattern');
  assert.strictEqual(a, icons.iconName('/home/u/pictures/logo.png'), 'stable for the same source');
  assert.notStrictEqual(a, icons.iconName('/home/u/pictures/other.png'), 'differs per source');
  assert.strictEqual(a.split('.')[0].length, icons.HASH_LEN);
});

test('stores an icon and returns its name', async () => {
  await withTempHome(async (home) => {
    const { paths } = require('../src/paths');
    paths.ensure();
    const source = makeSource(home, 'logo.png');
    const name = icons.storeIcon(source, fakeCodec());

    assert.ok(name && name.endsWith('.png'));
    assert.ok(fs.existsSync(path.join(paths.iconsDir(), name)), 'file written to the store');
  });
});

test('scales an oversized image down to the 256px bound', async () => {
  await withTempHome(async (home) => {
    const { paths } = require('../src/paths');
    paths.ensure();
    const source = makeSource(home, 'big.png');
    icons.storeIcon(source, fakeCodec({ width: 1024, height: 512 }));

    assert.deepStrictEqual(iconsCalls, [icons.ICON_SIZE], 'codec asked to bound by 256');
    const stored = fs.readFileSync(
      path.join(paths.iconsDir(), icons.iconName(source)),
      'utf8',
    );
    assert.strictEqual(stored, 'PNG 256x128', 'aspect ratio preserved, longest edge capped');
  });
});

test('leaves an image already within bounds unscaled', async () => {
  await withTempHome(async (home) => {
    const { paths } = require('../src/paths');
    paths.ensure();
    const source = makeSource(home, 'small.png');
    icons.storeIcon(source, fakeCodec({ width: 64, height: 64 }));

    const stored = fs.readFileSync(
      path.join(paths.iconsDir(), icons.iconName(source)),
      'utf8',
    );
    assert.strictEqual(stored, 'PNG 64x64');
  });
});

test('rejects a file the codec cannot read', async () => {
  await withTempHome(async (home) => {
    require('../src/paths').paths.ensure();
    const source = makeSource(home, 'broken.png');
    assert.strictEqual(icons.storeIcon(source, fakeCodec({ fail: true })), null);
  });
});

test('rejects a missing source file', async () => {
  await withTempHome(async () => {
    require('../src/paths').paths.ensure();
    assert.strictEqual(icons.storeIcon('/no/such/file.png', fakeCodec()), null);
    assert.strictEqual(icons.storeIcon('', fakeCodec()), null);
    assert.strictEqual(icons.storeIcon(null, fakeCodec()), null);
  });
});

test('re-importing the same source does not duplicate', async () => {
  await withTempHome(async (home) => {
    const { paths } = require('../src/paths');
    paths.ensure();
    const source = makeSource(home, 'logo.png');
    const first = icons.storeIcon(source, fakeCodec());
    const second = icons.storeIcon(source, fakeCodec());

    assert.strictEqual(first, second, 'same source yields the same name');
    assert.strictEqual(
      fs.readdirSync(paths.iconsDir()).filter((f) => f.endsWith('.png')).length,
      1,
      'no duplicate written',
    );
  });
});

test('resolveIcon refuses names that could escape the store', async () => {
  await withTempHome(async () => {
    const { paths } = require('../src/paths');
    paths.ensure();
    assert.strictEqual(icons.resolveIcon('../../etc/passwd'), null);
    assert.strictEqual(icons.resolveIcon('notahash.png'), null);
    assert.strictEqual(icons.resolveIcon(null), null);
    assert.strictEqual(icons.resolveIcon('aaaaaaaaaaaa.png'), null, 'absent file');
  });
});

test('deleteIcon removes the file and rejects unsafe names', async () => {
  await withTempHome(async (home) => {
    const { paths } = require('../src/paths');
    paths.ensure();
    const source = makeSource(home, 'logo.png');
    const name = icons.storeIcon(source, fakeCodec());

    assert.strictEqual(icons.deleteIcon('../../escape.png'), false);
    assert.strictEqual(icons.deleteIcon(name), true);
    assert.ok(!fs.existsSync(path.join(paths.iconsDir(), name)));
  });
});