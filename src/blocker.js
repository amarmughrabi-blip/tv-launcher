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

const { FiltersEngine, Request, fullLists } = require('@ghostery/adblocker');

/** Electron request types that are never blocked. */
const NEVER_BLOCK_TYPES = new Set(['mainFrame']);

class Blocker {
  constructor({ log = () => {} } = {}) {
    this.engine = null;
    this.log = log;
    this.stats = { blocked: 0, allowed: 0 };
  }

  /**
   * Load filter lists. Prefers the prebuilt bundle so a blocked network or an
   * unreachable list host degrades into slightly stale rules rather than an
   * app with no protection at all.
   */
  async load() {
    this.log('loading prebuilt filter lists');
    // `enableHtmlFiltering` defaults to false. Without it the engine parses tens
    // of thousands of cosmetic (element-hiding) rules and then discards them all
    // at match time, so the ads that were blocked at the network level still
    // arrive as invisible full-page overlays -- on top of buttons, swallowing
    // the click you meant for the site. Cosmetic filtering is the only thing
    // that removes them, so it has to be switched on explicitly.
    // `fromPrebuiltFull` hardcodes an empty config internally, so it cannot be
    // used here. `fromLists` takes the same bundled list set and does accept a
    // config. The lists ship with the package, so this still needs no network.
    this.engine = await FiltersEngine.fromLists(fetch, fullLists, {
      enableHtmlFiltering: true,
    });
    const { networkFilters, cosmeticFilters } = this.engine.getFilters();
    this.log(`engine ready — ${networkFilters.length} network filters, ${cosmeticFilters.length} cosmetic rules`);
    return this.engine;
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
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { styles: '', scripts: [] };
    }
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
    return { ...this.stats };
  }
}

module.exports = { Blocker, NEVER_BLOCK_TYPES };