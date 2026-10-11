'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Where the IPC handlers live.
 *
 * The main process registers most of its handlers inside a
 * `if (process.env.TVL_DEBUG_INPUT === '1')` block. Anything registered there
 * does not exist in a normal launch -- and the verification scripts all set that
 * flag, so every check passes while the thing they check is absent.
 *
 * That is not hypothetical. Two settings handlers were registered inside it,
 * which left a normal launch with no `settings:get` and no `settings:theme`.
 * theme.js asks for the theme synchronously during page parse; an unanswered
 * sendSync blocks the renderer before app.js has run, so the loading screen
 * cleared for nobody and the app looked hung. Intermittent, and invisible to the
 * whole suite.
 *
 * This reads the file rather than requiring it, because requiring main.js needs
 * Electron, and because the question is about the source.
 */

const MAIN = path.join(__dirname, '..', 'main.js');
const source = fs.readFileSync(MAIN, 'utf8');
const lines = source.split('\n');

/** The block opened by `if (process.env.TVL_DEBUG_INPUT === '1') {`. */
function debugBlockRange() {
  const open = lines.findIndex((l) => l.startsWith("if (process.env.TVL_DEBUG_INPUT === '1')"));
  assert.notStrictEqual(open, -1, 'the debug block should still exist');
  let depth = 0;
  for (let i = open; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth === 0 && i > open) return [open, i];
  }
  throw new Error('the debug block never closes');
}

/** Line numbers of every `ipcMain.on(` / `ipcMain.handle(` call. */
function registrations() {
  const found = [];
  lines.forEach((l, i) => {
    const m = /ipcMain\.(on|handle)\(\s*'([^']+)'/.exec(l);
    if (m) found.push({ line: i + 1, kind: m[1], channel: m[2], text: l.trim() });
  });
  return found;
}

/** Channels the renderer needs before it can paint anything. */
const REQUIRED_EVERYWHERE = [
  'settings:theme',
  'settings:get',
  'settings:set',
  'settings:reset',
  'settings:toggle-exception',
  'app:ready-state',
  'channels:get',
  'player:close',
];

test('the channels the renderer needs are not debug-only', () => {
  const [open, close] = debugBlockRange();
  const inside = registrations().filter((r) => r.line > open && r.line < close);

  for (const channel of REQUIRED_EVERYWHERE) {
    const where = registrations().filter((r) => r.channel === channel);
    assert.ok(where.length > 0, `${channel} is not registered at all`);
    for (const reg of where) {
      assert.ok(
        reg.line < open || reg.line > close,
        `${channel} is registered at line ${reg.line}, inside the TVL_DEBUG_INPUT block ` +
          `(${open + 1}-${close + 1}) -- it will not exist in a normal launch`,
      );
    }
  }

  // The reverse also matters: a debug channel that escaped its block would
  // expose itself in production.
  for (const reg of inside) {
    assert.ok(
      reg.channel.startsWith('debug:') || reg.channel.startsWith('verify'),
      `${reg.channel} is a debug-only channel registered outside the debug block`,
    );
  }
});

test('only genuinely debug channels live inside the debug block', () => {
  const [open, close] = debugBlockRange();
  const inside = registrations().filter((r) => r.line > open && r.line < close);
  assert.ok(inside.length > 0, 'the block should register something, or it should go');
  for (const reg of inside) {
    assert.ok(
      reg.channel.startsWith('debug:'),
      `${reg.channel} at line ${reg.line} is registered inside the debug block ` +
        'but is not named debug:* -- it will not exist in a normal launch',
    );
  }
});

test('the renderer asks for the theme synchronously, and that is deliberate', () => {
  // If this ever becomes an async call the loading screen will start flashing
  // the wrong colours again, so it is worth a test rather than a memory.
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const match = /bootTheme:\s*\(\)\s*=>\s*([^\n]+)/.exec(preload);
  assert.ok(match, 'bootTheme should still exist');
  assert.match(
    match[1],
    /sendSync/,
    'bootTheme must stay synchronous: an async reply arrives after the first frame',
  );
});
