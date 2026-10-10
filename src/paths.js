'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const APP_DIR_NAME = 'adblock-launcher';

/** Root data directory, overridable for tests. */
function dataRoot() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, APP_DIR_NAME);
}

const paths = {
  appDir: () => dataRoot(),
  /** Named sets of sites. */
  profilesFile: () => path.join(dataRoot(), 'profiles.json'),
  /** Pre-profiles format; read once on first run, then left as a backup. */
  sitesFile: () => path.join(dataRoot(), 'sites.json'),
  iconsDir: () => path.join(dataRoot(), 'icons'),
  cacheDir: () => path.join(dataRoot(), 'cache'),
  /** Scratch space for browser state that must not live beside user data. */
  runtimeDir: () => path.join(dataRoot(), 'runtime'),

  /** Create every directory the app writes to. */
  ensure() {
    for (const dir of [paths.appDir(), paths.iconsDir(), paths.cacheDir(), paths.runtimeDir()]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return paths;
  },
};

module.exports = { paths, APP_DIR_NAME };