'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Settings.
 *
 * Every read has to produce a usable value even from a corrupt, truncated or
 * hand-edited file. These settings are read on the paths that decide whether the
 * app draws a grid, plays a stream or blocks a request, so a missing key there is
 * a crash rather than a default -- and an app that will not start because
 * somebody typed a stray character in a JSON file is not acceptable.
 */

const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlauncher-settings-'));
process.env.XDG_DATA_HOME = dataHome;

const settings = require('../src/settings');
const { paths } = require('../src/paths');

test.after(() => {
  fs.rmSync(dataHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  settings.reset();
});

/** Write something unusable straight to disk. */
function corrupt(text) {
  fs.writeFileSync(paths.settingsFile(), text);
}

test('a fresh install gets every default', () => {
  const all = settings.all();
  assert.strictEqual(Object.keys(all).length, Object.keys(settings.DEFAULTS).length);
  for (const [key, value] of Object.entries(settings.DEFAULTS)) {
    assert.deepStrictEqual(all[key], value, `${key} did not default`);
  }
});

test('the defaults are the ones that were argued for', () => {
  // Each of these was chosen on purpose; a later change should be deliberate.
  assert.strictEqual(settings.get('checkSchedule'), 'never', 'no unrequested background traffic');
  assert.strictEqual(settings.get('deadDays'), 7, 'days, not attempts');
  assert.strictEqual(settings.get('muteOnOpen'), true);
  assert.strictEqual(settings.get('maxQuality'), '720');
  assert.strictEqual(settings.get('adBlocking'), true);
  assert.strictEqual(settings.get('hideInPageAds'), true);
  assert.strictEqual(settings.get('subtitles'), 'off');
  assert.strictEqual(settings.get('hiddenGenres').length, 0, 'every genre until the viewer hides some');
  assert.strictEqual(settings.get('region').length, 0);
});

test('a missing file reads as defaults rather than throwing', () => {
  fs.rmSync(paths.settingsFile(), { force: true });
  assert.strictEqual(settings.get('adBlocking'), true);
});

test('a corrupt file reads as defaults rather than throwing', () => {
  for (const junk of ['', '{', 'not json at all', '[]', 'null']) {
    corrupt(junk);
    assert.strictEqual(settings.get('maxQuality'), '720', `failed on ${JSON.stringify(junk)}`);
  }
});

test('a value of the wrong type falls back instead of leaking through', () => {
  corrupt(JSON.stringify({
    adBlocking: 'yes',
    deadDays: 'soon',
    hiddenGenres: 'news',
    maxQuality: '4320p',
    checkSchedule: 'hourly',
    subtitles: 'maybe',
  }));
  const all = settings.all();
  assert.strictEqual(all.adBlocking, true);
  assert.strictEqual(all.deadDays, 7);
  assert.deepStrictEqual(all.hiddenGenres, []);
  assert.strictEqual(all.maxQuality, '720');
  assert.strictEqual(all.checkSchedule, 'never');
  assert.strictEqual(all.subtitles, 'off');
});

test('zero days cannot hide a channel on its first failure', () => {
  // The whole point of this setting is that a bad night does not lose a channel.
  assert.strictEqual(settings.set({ deadDays: 0 }).deadDays, 1);
  assert.strictEqual(settings.set({ deadDays: -5 }).deadDays, 1);
});

test('days are clamped to something a person meant', () => {
  assert.strictEqual(settings.set({ deadDays: 400 }).deadDays, 365);
  assert.strictEqual(settings.set({ deadDays: 3.4 }).deadDays, 3);
});

test('subtitle size is clamped to something legible', () => {
  assert.strictEqual(settings.set({ subtitleSize: 2 }).subtitleSize, 10);
  assert.strictEqual(settings.set({ subtitleSize: 900 }).subtitleSize, 72);
});

test('saving one field does not blank out the rest', () => {
  settings.set({ adBlocking: false, region: ['GB', 'IE'] });
  settings.set({ deadDays: 3 });
  const all = settings.all();
  assert.strictEqual(all.adBlocking, false, 'a second save must not reset other fields');
  assert.deepStrictEqual(all.region, ['GB', 'IE']);
  assert.strictEqual(all.deadDays, 3);
});

test('an unknown setting is ignored rather than written', () => {
  const saved = settings.set({ nonsense: true, deadDays: 4 });
  assert.ok(!Object.hasOwn(saved, 'nonsense'));
  assert.strictEqual(saved.deadDays, 4);
});

test('reading an unknown setting is a loud error, not a silent undefined', () => {
  assert.throws(() => settings.get('nonsense'), /unknown setting/);
});

test('list settings drop junk entries', () => {
  const saved = settings.set({ region: ['GB', '', null, '  ie  ', 42, 'FR'] });
  assert.deepStrictEqual(saved.region, ['GB', 'ie', 'FR']);
});

test('a genre is shown unless the viewer hid it', () => {
  assert.strictEqual(settings.genreVisible('news'), true);
  settings.set({ hiddenGenres: ['legislative'] });
  assert.strictEqual(settings.genreVisible('legislative'), false);
  assert.strictEqual(settings.genreVisible('news'), true);
});

test('the region filter is off until a region is chosen', () => {
  assert.strictEqual(settings.countryVisible('QA'), true, 'no filter by default');
  assert.strictEqual(settings.countryVisible(''), true);
  settings.set({ region: ['GB', 'IE'] });
  assert.strictEqual(settings.countryVisible('GB'), true);
  assert.strictEqual(settings.countryVisible('QA'), false);
  // A channel with no country cannot pass a filter it is not in.
  assert.strictEqual(settings.countryVisible(''), false);
});

test('quality cap: auto means no cap, otherwise the level number', () => {
  assert.strictEqual(settings.levelCap(), 720);
  settings.set({ maxQuality: 'auto' });
  assert.strictEqual(settings.levelCap(), -1, 'hls.js reads -1 as no cap');
  settings.set({ maxQuality: '480' });
  assert.strictEqual(settings.levelCap(), 480);
});

test('audio languages are a preference order, best first', () => {
  assert.deepStrictEqual(settings.audioLanguages(), ['en']);
  settings.set({ audioLanguage: 'en, ar ,EN' });
  assert.deepStrictEqual(settings.audioLanguages(), ['en', 'ar']);
  settings.set({ audioLanguage: '' });
  assert.deepStrictEqual(settings.audioLanguages(), []);
});

test('an exception covers its own host and its subdomains, and nothing else', () => {
  settings.set({ blockingExceptions: ['example.com'] });
  assert.strictEqual(settings.isExempt('example.com'), true);
  assert.strictEqual(settings.isExempt('www.example.com'), true);
  assert.strictEqual(settings.isExempt('cdn.example.com'), true);
  // The dot matters: without it "notexample.com" would match a site nobody
  // exempted, and blocking would quietly stop working on it.
  assert.strictEqual(settings.isExempt('notexample.com'), false);
  assert.strictEqual(settings.isExempt('example.com.evil.net'), false);
  assert.strictEqual(settings.isExempt(''), false);
});

test('no exceptions means nothing is exempt', () => {
  assert.strictEqual(settings.isExempt('example.com'), false);
});

test('the theme is one of the three, and a typo does not blank the screen', () => {
  // A bad value here would resolve to an undefined data-theme, and every
  // `data-theme='light'` rule would simply not apply -- which is the same as
  // having no theme setting at all.
  for (const value of ['dark', 'light', 'system']) {
    assert.strictEqual(settings.set({ theme: value }).theme, value);
  }
  for (const junk of ['sepia', '', null, 42, undefined]) {
    assert.strictEqual(settings.set({ theme: junk }).theme, 'dark', `accepted ${JSON.stringify(junk)}`);
  }
});

test('reset puts everything back', () => {
  settings.set({ adBlocking: false, deadDays: 2, region: ['GB'] });
  settings.reset();
  assert.strictEqual(settings.get('adBlocking'), true);
  assert.strictEqual(settings.get('deadDays'), 7);
  assert.deepStrictEqual(settings.get('region'), []);
  assert.strictEqual(settings.get('theme'), 'dark');
});