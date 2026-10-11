'use strict';

/**
 * One-off: load the researched channel list into the app.
 *
 * The source is a dictionary keyed by stream URL. That key is discarded -- it is
 * an artefact of how the list was scraped, and the URL itself is the identity.
 *
 *   node scripts/import-channels.js [path]
 *
 * Refuses to clobber an existing list without --force, because the import is
 * cheap to repeat but a hand-edited list would not be.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SOURCE = path.join(
  process.env.HOME || '/root',
  '.cache/tvchannels/unique_full.json',
);

function main() {
  const argv = process.argv.slice(2);
  const source = argv.find((a) => !a.startsWith('--')) || DEFAULT_SOURCE;
  const force = argv.includes('--force');

  const channels = require('../src/channels');
  const dest = require('../src/paths').paths.channelsFile();
  if (fs.existsSync(dest) && !force) {
    console.log(`channels already imported to ${dest}`);
    console.log('pass --force to replace them');
    return 0;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch (err) {
    console.error(`cannot read ${source}: ${err.message}`);
    return 1;
  }

  const records = Array.isArray(raw) ? raw : Object.values(raw);
  const written = channels.writeAll(records);
  const s = channels.summary();
  console.log(`read ${records.length} from ${source}`);
  console.log(`wrote ${written} channels to ${dest}`);
  console.log(`${s.genres} genres, ${s.total} total`);
  return 0;
}

process.exit(main());