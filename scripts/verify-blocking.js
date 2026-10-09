'use strict';

/**
 * Live blocking verification.
 *
 * The unit tests prove the engine's decision logic. This proves the decisions
 * actually reach a real renderer: a served page requests known advertising and
 * tracker URLs, the blocker is attached to the session it loads in, and every
 * request is recorded as it is made.
 *
 * Only the last-registered onBeforeRequest listener runs, so this drives
 * Blocker.decide() directly rather than also calling attach(); that keeps the
 * decision logic under test while still observing live traffic.
 *
 *   ./scripts/run.sh scripts/verify-blocking.js
 */

const http = require('http');
const { app, BrowserWindow, session } = require('electron');
const { Blocker } = require('../src/blocker');

const log = (...a) => console.log('[verify]', ...a);

/** Requests the page will make. Expectation is what the engine should do. */
const PROBES = [
  { url: 'https://www.google-analytics.com/analytics.js', type: 'script', expect: 'blocked' },
  { url: 'https://ad.doubleclick.net/ddm/ad.js', type: 'script', expect: 'blocked' },
  { url: 'https://example.com/app.js', type: 'script', expect: 'allowed' },
  { url: 'https://example.com/style.css', type: 'stylesheet', expect: 'allowed' },
  { url: 'https://example.com/hero.png', type: 'image', expect: 'allowed' },
];

function page() {
  const tags = [
    ...PROBES.map((p) => `<script src="${p.url}"></script>`),
    `<link rel="stylesheet" href="${PROBES[3].url}">`,
    `<img src="${PROBES[4].url}">`,
  ].join('\n');
  return `<!doctype html><meta charset="utf-8"><title>blocking check</title>${tags}`;
}

app.whenReady().then(async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const blocker = new Blocker({ log: () => {} });
  await blocker.load();
  log(`engine ready — ${blocker.engine.getFilters().networkFilters.length} filters`);

  const observed = new Map();
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest((details, callback) => {
    const request = Blocker.toRequest(details);
    const verdict = blocker.decide(request);
    // Only record the URLs we asked about; page requests are noise here.
    const known = PROBES.find((p) => p.url === details.url);
    if (known) observed.set(known.url, verdict.cancel ? 'blocked' : 'allowed');
    callback({ cancel: verdict.cancel });
  });

  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  await win.loadURL(`${origin}/`);
  // Give the subresources a moment to be requested and adjudicated.
  await new Promise((r) => setTimeout(r, 2500));
  win.destroy();
  server.close();

  log('');
  let failures = 0;
  for (const probe of PROBES) {
    const actual = observed.get(probe.url) || 'not-requested';
    const ok = actual === probe.expect;
    if (!ok) failures += 1;
    log(`${ok ? 'ok  ' : 'FAIL'}  ${probe.expect.padEnd(8)} ${probe.url}  [${actual}]`);
  }

  log('');
  log(`blocker counters: ${JSON.stringify(blocker.summary)}`);
  log('');
  log(failures === 0 ? 'RESULT: PASS — live blocking matches expectations' : `RESULT: FAIL — ${failures} mismatch(es)`);
  app.exit(failures === 0 ? 0 : 1);
});