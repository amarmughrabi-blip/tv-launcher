'use strict';

/**
 * Ad blocking.
 *
 * The filter engine does the parsing and the matching; this module is only the
 * bridge between it and the Electron session. Two things it does care about:
 *
 *  - Exception filters win. A request matched by both a blocking rule and an
 *    `@@` exception is allowed, which is the whole point of exceptions and the
 *    easiest thing to get wrong.
 *  - Top-level navigation is never blocked. Breaking the main frame means the
 *    site does not load at all, which is never what a blocking rule intended.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { FiltersEngine, Request, fullLists } = require('@ghostery/adblocker');
const settingsStore = require('./settings');
const { paths } = require('./paths');

/** Electron request types that are never blocked. */
const NEVER_BLOCK_TYPES = new Set(['mainFrame']);

/**
 * What the cached engine was built from.
 *
 * Deserialising is eighty times faster than parsing, but a cache from a
 * different build of the filter data would be stale in a way nothing could
 * detect later -- it would simply block the wrong things. So the stamp covers
 * the library version and the list set, and anything else throws the cache away.
 */
function cacheStamp() {
  const version = require('@ghostery/adblocker/package.json').version;
  const lists = fullLists
    .map((list) => `${list.name || ''}:${list.url || ''}`)
    .sort()
    .join('\n');
  const digest = crypto.createHash('sha256').update(lists).digest('hex').slice(0, 16);
  return { version, digest, stamp: `${version}-${digest}` };
}

class Blocker {
  constructor({ log = () => {}, settings = null } = {}) {
    this.engine = null;
    this.log = log;
    // Resolves once the engine exists, whoever asked for it. Callers that
    // genuinely need blocking -- opening a site, say -- await this instead of
    // assuming it is already there.
    this.loading = null;
    // Read through a function rather than captured once: the settings screen can
    // be opened at any time, and a snapshot taken at boot would leave the master
    // switch doing nothing until the next launch.
    //
    // The default returns the defaults rather than reading the file, because this
    // runs once per network request and re-reading and re-parsing settings on
    // every request to a page would be absurd. Main passes a cached getter that
    // it refreshes whenever the settings change.
    this.settings = settings || (() => settingsStore.DEFAULTS);
    this.stats = { blocked: 0, allowed: 0, exempted: 0 };
  }

  /** Whether anything should be blocked at all right now. */
  get enabled() {
    return this.settings().adBlocking !== false;
  }

  /**
   * Get an engine, from the cache when there is one.
   *
   * Parsing the bundled lists takes about four seconds and blocks the main
   * process outright for the whole of it. Serialising the result and reading it
   * back takes well under a tenth of a second, so the parse happens once and
   * every launch after that is a deserialise.
   *
   * The lists ship inside the package, so this needs no network either way -- a
   * cache miss is slower, never broken.
   */
  async load() {
    if (this.ready) return this.engine;
    // One parse, however many callers. Without this, opening a site during a
    // cold start would kick off a second four-second parse on top of the first.
    if (!this.loading) {
      this.loading = (async () => {
        const restored = this.restore();
        if (restored) return this.engine;
        this.log('no cached filter engine — parsing the lists (first run only)');
        return this.parseAndCache();
      })();
    }
    return this.loading;
  }

  /**
   * Wait for the engine, but never indefinitely.
   *
   * A site opened during a cold start should still be blocked, so this waits --
   * but not forever, because the point of taking the parse off the startup path
   * is that nothing is allowed to wait on it without an end.
   */
  async ensureReady(timeoutMs = 10_000) {
    if (this.ready) return true;
    if (!this.loading) return false;
    let timer;
    const cap = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      await Promise.race([this.loading.then(() => true).catch(() => false), cap]);
      return this.ready;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read a previously serialised engine back, if it is still current. */
  restore() {
    try {
      const file = paths.cacheDir();
      const stampPath = path.join(file, 'blocker-engine.stamp');
      const enginePath = path.join(file, 'blocker-engine.bin');
      if (fs.existsSync(stampPath) && fs.existsSync(enginePath)) {
        if (fs.readFileSync(stampPath, 'utf8').trim() !== cacheStamp().stamp) {
          this.log('cached filter engine is from a different build — rebuilding');
          return null;
        }
        const started = Date.now();
        const buffer = fs.readFileSync(enginePath);
        this.engine = FiltersEngine.deserialize(buffer);
        const { networkFilters, cosmeticFilters } = this.engine.getFilters();
        this.log(
          `engine restored from cache in ${Date.now() - started}ms — ` +
            `${networkFilters.length} network filters, ${cosmeticFilters.length} cosmetic rules`,
        );
        return this.engine;
      }
    } catch (err) {
      // A corrupt or unreadable cache is not a reason to fail: fall through and
      // parse, which is slower but always works.
      this.log(`cached engine unusable (${err.message}) — parsing instead`);
      this.engine = null;
    }
    return null;
  }

  /** Parse the bundled lists and keep the result for next time. */
  async parseAndCache() {
    this.log('parsing prebuilt filter lists');
    // `enableHtmlFiltering` defaults to false. Without it the engine parses tens
    // of thousands of cosmetic (element-hiding) rules and then discards them all
    // at match time, so the ads that were blocked at the network level still
    // arrive as invisible full-page overlays -- on top of buttons, swallowing
    // the click you meant for the site. Cosmetic filtering is the only thing
    // that removes them, so it has to be switched on explicitly.
    // `fromPrebuiltFull` hardcodes an empty config internally, so it cannot be
    // used here. `fromLists` takes the same bundled list set and does accept a
    // config. The lists ship with the package, so this still needs no network.
    const started = Date.now();
    this.engine = await FiltersEngine.fromLists(fetch, fullLists, {
      enableHtmlFiltering: true,
    });
    const { networkFilters, cosmeticFilters } = this.engine.getFilters();
    this.log(
      `engine ready in ${Date.now() - started}ms — ` +
        `${networkFilters.length} network filters, ${cosmeticFilters.length} cosmetic rules`,
    );
    this.cache();
    return this.engine;
  }

  /** Keep the serialised engine so the next launch does not have to parse. */
  cache() {
    try {
      if (!this.engine) return;
      const dir = paths.cacheDir();
      fs.mkdirSync(dir, { recursive: true });
      const enginePath = path.join(dir, 'blocker-engine.bin');
      // Written to a temporary name and renamed, so a launch that dies halfway
      // through leaves the previous cache intact rather than a truncated file
      // that deserialises into nothing.
      const temp = `${enginePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, this.engine.serialize());
      fs.renameSync(temp, enginePath);
      fs.writeFileSync(path.join(dir, 'blocker-engine.stamp'), `${cacheStamp().stamp}\n`);
    } catch (err) {
      this.log(`could not cache the filter engine: ${err.message}`);
    }
  }

  get ready() {
    return this.engine !== null;
  }

  /**
   * Decide what to do with one request.
   *
   * `FiltersEngine.match()` is the authority here, not `matchAll()`. matchAll
   * returns raw NetworkFilters and would leave exception precedence to us;
   * match() has already applied it, and also resolves redirect/scriptlet rules
   * into the replacement body it wants to inject. Re-deriving any of that here
   * is how whitelist rules end up ignored.
   *
   * Pure with respect to the engine, so it can be tested without a session.
   */
  decide(request) {
    if (!this.engine) return { cancel: false, matched: null };

    // The master switch. Checked before anything else so that turning blocking
    // off is immediate and complete -- not "off except for the rules that were
    // already decided", which is how a kill switch that does not kill arrives.
    if (!this.enabled) {
      this.stats.allowed += 1;
      return { cancel: false, matched: null };
    }

    // A per-site exception is the escape hatch for the one page that will not
    // load with filtering on. Checked on the top-level document's host so it
    // covers the whole site, and counted separately so "blocking is on but this
    // site is exempt" is visible in the totals rather than looking like a leak.
    // `hostname` is a property on Request, not a method -- calling it as one
    // throws on every single request, which takes out all blocking rather than
    // just the exemption.
    if (this.isExempt(request && request.hostname)) {
      this.stats.exempted += 1;
      this.stats.allowed += 1;
      return { cancel: false, matched: null };
    }

    if (request && NEVER_BLOCK_TYPES.has(request.type)) {
      // Never blocked, and counted as allowed so the totals mean
      // "requests that got through" rather than "requests the engine saw".
      this.stats.allowed += 1;
      return { cancel: false, matched: null };
    }

    let response;
    try {
      response = this.engine.match(request);
    } catch {
      return { cancel: false, matched: null };
    }

    if (!response || !response.match) {
      this.stats.allowed += 1;
      return { cancel: false, matched: null };
    }

    this.stats.blocked += 1;
    return { cancel: true, matched: response.match === true ? 'filter' : String(response.match) };
  }

  /** Whether this host has been exempted by the viewer. */
  isExempt(hostname) {
    if (!hostname) return false;
    return settingsStore.isExempt(hostname, this.settings());
  }

  /** Build a matchable request from Electron's onBeforeRequest details. */
  static toRequest(details) {
    try {
      return Request.fromRawDetails(details);
    } catch {
      return null;
    }
  }

  /** Wire the engine into a session's request pipeline. */
  attach(session) {
    if (!this.engine) throw new Error('blocker used before load()');
    // Guarded because blocking is now attached from two places: when the engine
    // finishes loading, and on a site opened during that window. Electron keeps
    // only the most recent onBeforeRequest handler, so a second call replaces
    // the first rather than adding to it -- which would be fine, and is still not
    // worth leaving to chance when it is guarding every request a site makes.
    if (this.attached) return this;
    this.attached = true;
    session.webRequest.onBeforeRequest((details, callback) => {
      const request = Blocker.toRequest(details);
      if (!request) return callback({ cancel: false });
      const { cancel, matched } = this.decide(request);
      if (cancel) {
        this.log(`blocked ${details.url.slice(0, 90)}`);
        return callback({ cancel: true });
      }
      return callback({ cancel: false });
    });
    return this;
  }

  /**
   * CSS hiding the ads that made it through the network pass.
   *
   * Blocking a request stops the ad's payload loading, but most sites ship the
   * ad markup in the page itself. Those arrive as transparent full-viewport
   * overlays stacked on top of the content, so the click you aim at a button
   * lands on the ad instead and you are navigated somewhere else. Only cosmetic
   * filtering removes them, which is why this is not optional.
   *
   * Uses `getCosmeticsFilters`, not `getHtmlFilters`: the latter reads a bucket
   * the engine leaves empty, and silently returns nothing at all.
   */
  cosmeticsFor(url) {
    if (!this.engine) return { styles: '', scripts: [] };
    // Separately switchable from the master switch, and the first thing to turn
    // off when a page will not click properly. A network block removes a
    // request; a cosmetic rule hides an element the page's own scripts still
    // expect to find, so over-hiding can take a control away with the ad.
    if (!this.settings().hideInPageAds) return { styles: '', scripts: [] };

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { styles: '', scripts: [] };
    }
    if (this.isExempt(parsed.hostname)) return { styles: '', scripts: [] };
    try {
      const result = this.engine.getCosmeticsFilters({
        url,
        hostname: parsed.hostname,
        domain: parsed.hostname.replace(/^www\./, ''),
      });
      return { styles: result.styles || '', scripts: result.scripts || [] };
    } catch (err) {
      this.log(`cosmetics failed for ${url}: ${err.message}`);
      return { styles: '', scripts: [] };
    }
  }

  get summary() {
    return { ...this.stats, enabled: this.enabled, ready: this.ready };
  }
}

module.exports = { Blocker, NEVER_BLOCK_TYPES };