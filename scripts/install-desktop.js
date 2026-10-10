'use strict';

/**
 * Installs a desktop entry so the launcher appears in the application menu.
 *
 * Paths are written absolutely: the menu does not inherit a working directory
 * from a shell, so a relative Exec or a missing WorkingDirectory produces an
 * entry that silently does nothing when clicked.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { surface } = require('./lib/png');

const ROOT = path.resolve(__dirname, '..');
const SIZE = 256;

const APP_ID = 'tv-launcher';
const ENTRY = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'applications',
  `${APP_ID}.desktop`,
);
const ICON_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'icons',
  'hicolor',
  `${SIZE}x${SIZE}`,
  'apps',
);
const ICON_PATH = path.join(ICON_DIR, `${APP_ID}.png`);

/** A dark tile with a wall of coloured app tiles, matching the launcher's look. */
function buildIcon() {
  const s = surface(SIZE, SIZE, [11, 13, 18]);
  const pad = 20;
  const radius = 44;

  s.roundRect(pad, pad + 14, SIZE - pad * 2, SIZE - pad * 2 - 14, radius, [24, 28, 37]);

  // A selection bar across the top, echoing the launcher's toolbar.
  s.roundRect(pad + 14, pad + 30, 54, 8, 4, [76, 141, 255]);

  const tiles = [
    [0, [214, 90, 80]],
    [1, [64, 160, 220]],
    [2, [150, 110, 220]],
    [3, [70, 180, 130]],
  ];

  const cell = 44;
  const gap = 12;
  const startX = pad + 14;
  const startY = pad + 52;

  for (const [index, colour] of tiles) {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const x = startX + col * (cell + gap);
    const y = startY + row * (cell + gap);
    s.roundRect(x, y, cell, cell, 12, colour);
  }

  // One tile highlighted, to read as "selected" at small sizes.
  s.roundRect(
    startX + 3 * (cell + gap) - 4,
    startY - 4,
    cell + 8,
    cell + 8,
    15,
    [236, 240, 248],
  );
  s.roundRect(startX + 3 * (cell + gap), startY, cell, cell, 12, [76, 141, 255]);

  return s.toPNG();
}

function writeEntry() {
  const runner = path.join(ROOT, 'scripts', 'run.sh');
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=TV Launcher
GenericName=Ad-Blocked Site Launcher
Comment=Browse your sites in one window, with ads and scripts blocked
Exec=${runner}
Path=${ROOT}
Icon=${APP_ID}
Terminal=false
Categories=Network;WebBrowser;
Keywords=launcher;tv;kiosk;adblock;streaming;
StartupNotify=true
StartupWMClass=tv-launcher
`;
}

function main() {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  fs.writeFileSync(ICON_PATH, buildIcon());
  console.log(`icon   ${ICON_PATH}`);

  fs.mkdirSync(path.dirname(ENTRY), { recursive: true });
  fs.writeFileSync(ENTRY, writeEntry());
  console.log(`entry  ${ENTRY}`);

  // Refresh the menu cache; without this the entry may not appear until logout.
  const cacheDir = path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'applications',
  );
  const res = spawnSync('update-desktop-database', [cacheDir], { stdio: 'ignore' });
  if (res.error) {
    console.log('note: update-desktop-database unavailable; the entry still works');
  } else {
    console.log('menu cache refreshed');
  }

  console.log('\nTV Launcher should now be in your application menu.');
}

main();