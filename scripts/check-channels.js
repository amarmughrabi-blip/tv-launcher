'use strict';

/**
 * Channel health, from a terminal.
 *
 * Free streams rot. Roughly 44% of a community playlist was already dead when
 * it was last checked, so a list that is only ever added to slowly fills with
 * tiles that go nowhere.
 *
 *   node scripts/check-channels.js [--concurrency N] [--reset] [--quiet]
 *                                   [--dry-run] [--which all|unchecked|failed]
 *
 * Three rules, all deliberate:
 *
 *  - A channel is dropped only after failing on several *days in a row*. One
 *    failure is far more likely to be a flaky connection than a channel that has
 *    gone, and three in one evening is a bad network rather than a dead stream --
 *    so the unit is the calendar day, not the attempt.
 *  - Only *hard* failures count. A timeout, a reset, a 403 from a geo-block or a
 *    5xx say more about this machine than about the channel, and counting them
 *    would hide channels that work perfectly for someone else.
 *  - The master list is never rewritten. Results go to channel-health.json and are
 *    merged at read time, so re-probing cannot damage the researched list.
 *
 * The probe and the classifier are shared with the app. If this script had its
 * own, a sweep run here would count differently from one the app makes while
 * playing -- and the harder of the two to reason about would be the one being
 * run by hand.
 */

const channels = require('../src/channels');
const { probe, classify } = require('../src/channel-probe');
const { shouldCount } = require('../src/channel-health');
const { paths } = require('../src/paths');
const fs = require('node:fs');

const DEFAULT_CONCURRENCY = 12;

async function main() {
  const argv = process.argv.slice(2);
  const concurrency = Number(
    argv[argv.indexOf('--concurrency') + 1] || DEFAULT_CONCURRENCY,
  ) || DEFAULT_CONCURRENCY;
  const reset = argv.includes('--reset');
  const quiet = argv.includes('--quiet');
  // A sweep that cannot be undone without re-probing everything is a sweep worth
  // being able to look at first.
  const dryRun = argv.includes('--dry-run');
  const which = argv[argv.indexOf('--which') + 1] || 'unchecked';

  const every = channels.all();
  if (!every.length) {
    console.error('no channels imported — run scripts/import-channels.js first');
    return 1;
  }

  const healthPath = paths.channelHealthFile();
  let health = {};
  if (!reset) {
    try {
      health = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
    } catch {
      health = {};
    }
  }

  const list = pick(every, which);
  if (!list.length) {
    console.error(`nothing to check for --which ${which}`);
    return 1;
  }

  console.log(`probing ${list.length} channels, ${concurrency} at a time`);
  const at = new Date().toISOString();
  let done = 0;
  let newlyDead = 0;
  let recovered = 0;
  let uncertain = 0;
  let hardFailed = 0;
  const wouldHide = [];

  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const channel = list[cursor];
      cursor += 1;
      const result = await probe(channel.url);
      const reason = classify(result);

      const previous = health[channel.url] || { fails: 0 };
      const wasDead = channels.isDead(previous);
      if (result.ok) {
        if (channels.streakDays(previous.days) > 0) recovered += 1;
        health[channel.url] = { fails: 0, days: [], at, reason: null };
      } else if (!shouldCount(reason)) {
        // Recorded so the app can explain it, but the day run does not move. A
        // channel failing all week that times out tonight is not thereby healthy.
        uncertain += 1;
        health[channel.url] = { ...previous, fails: previous.fails || 0, at, reason };
      } else {
        hardFailed += 1;
        const days = channels.noteFailure(previous, new Date(at));
        const record = { fails: (previous.fails || 0) + 1, days, at, reason };
        health[channel.url] = record;
        if (!wasDead && channels.isDead(record)) {
          newlyDead += 1;
          wouldHide.push({ name: channel.name, reason });
        }
      }

      done += 1;
      if (!quiet && done % 25 === 0) process.stdout.write(`  ${done}/${list.length}\n`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  if (dryRun) {
    console.log('');
    console.log(`dry run — nothing written`);
    console.log(`would newly hide ${wouldHide.length}, recovered ${recovered}, uncertain ${uncertain}`);
    for (const entry of wouldHide.slice(0, 40)) {
      console.log(`  hide  ${entry.name} — ${entry.reason}`);
    }
    if (wouldHide.length > 40) console.log(`  ... and ${wouldHide.length - 40} more`);
    return 0;
  }

  fs.mkdirSync(paths.appDir(), { recursive: true });
  fs.writeFileSync(healthPath, `${JSON.stringify(health, null, 1)}\n`);

  const s = channels.summary();
  console.log('');
  console.log(`probed ${done} channels`);
  console.log(`live ${s.live} / hidden ${s.hidden} of ${s.total}`);
  console.log(`hard failures ${hardFailed}, newly hidden ${newlyDead}, recovered ${recovered}`);
  console.log(`could not be judged ${uncertain} (timed out, or blocked here — not counted)`);
  console.log(`written to ${healthPath}`);
  console.log('');
  console.log(`a channel is hidden after failing on ${channels.deadDays()} days in a row`);
  console.log('--reset forgets the history and starts counting again');
  console.log('--dry-run reports without writing');
  return 0;
}

/**
 * Which channels this run is about.
 *
 * `unchecked` is the default because those are the ones doing nothing: nobody
 * has ever opened them, so nothing is known about whether they still work.
 */
function pick(list, which) {
  if (which === 'all') return list;
  if (which === 'failed') return list.filter((c) => c.fails > 0);
  return list.filter((c) => !c.checked);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });