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

const { FiltersEngine, Request } = require('@ghostery/adblocker');

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
    this.engine = await FiltersEngine.fromPrebuiltFull();
    this.log(`engine ready — ${this.engine.getFilters().networkFilters.length} network filters`);
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

  /** CSS hiding the ads that made it through the network pass. */
  async cosmeticsFor(request) {
    if (!this.engine) return null;
    try {
      return this.engine.getHtmlFilters(request);
    } catch {
      return null;
    }
  }

  get summary() {
    return { ...this.stats };
  }
}

module.exports = { Blocker, NEVER_BLOCK_TYPES };