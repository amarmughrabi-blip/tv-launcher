'use strict';

/**
 * Channel health: what went wrong, and what to say about it.
 *
 * One classifier, shared by the app and by scripts/check-channels.js. They must
 * agree, or a sweep run from a terminal would count differently from one the app
 * makes while playing.
 *
 * The distinction that matters is hard against soft:
 *
 *   hard  the stream is gone. The host does not resolve, nothing is listening,
 *         the path is a 404, the address answers with something that is not a
 *         manifest. These count, and eventually hide the channel.
 *
 *   soft  we cannot tell, or we know the failure says more about here than
 *         about the channel: a timeout, a reset, a 403 from a geo-block, a 5xx.
 *         None of these count. Counting them would hide channels that work
 *         perfectly for someone else -- and a timeout is usually just a network
 *         having a bad moment.
 *
 * Geo-blocking is the case this exists for. A 403 from a broadcaster says the
 * stream is fine and this machine may not watch it, which is the opposite of
 * dead.
 */

/** Verdict plus the plain words to put on screen. */
const REASONS = {
  ok: { verdict: 'ok', say: () => '' },

  dns: {
    verdict: 'hard',
    say: () => 'This channel’s stream address no longer exists.',
  },
  refused: {
    verdict: 'hard',
    say: () => 'Nothing is listening at this channel’s stream address.',
  },
  gone: {
    verdict: 'hard',
    say: () => 'This channel’s stream has been taken down.',
  },
  notManifest: {
    verdict: 'hard',
    say: () => 'That address answers, but there is no TV stream at it.',
  },
  noSegments: {
    verdict: 'hard',
    say: () => 'This channel is not broadcasting right now.',
  },
  timeout: {
    verdict: 'soft',
    say: () => 'The stream did not respond in time. That is often temporary.',
  },
  reset: {
    verdict: 'soft',
    say: () => 'The connection to the stream was dropped.',
  },
  blocked: {
    verdict: 'soft',
    say: () => 'The broadcaster refused this connection, which usually means the channel is blocked in this region.',
  },
  unreachable: {
    verdict: 'soft',
    say: () => 'That address cannot be reached from here, which is usually a network problem or a block rather than a dead channel.',
  },
  server: {
    verdict: 'soft',
    say: () => 'The broadcaster’s server had a problem.',
  },
  refusedPlay: {
    verdict: 'soft',
    say: () => 'The stream started but could not be played here.',
  },
  unknown: {
    verdict: 'soft',
    say: () => 'Something went wrong with this stream.',
  },
};

/** Map a network error code or HTTP status onto a reason. */
function reasonFor({ code = null, status = null, body = null } = {}) {
  if (body === 'not a manifest') return 'notManifest';
  if (body === 'no segments') return 'noSegments';

  if (status === 404 || status === 410) return 'gone';
  if (status === 403 || status === 401) return 'blocked';
  if (status >= 500) return 'server';

  switch (code) {
    case 'ENOTFOUND':
      return 'dns';
    case 'ECONNREFUSED':
      return 'refused';
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return 'timeout';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'reset';
    case 'EAI_AGAIN':
      // DNS itself failed temporarily. The host may well be fine.
      return 'reset';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
    case 'ENETDOWN':
      // The route is missing, not the channel. Saying "unreachable" rather than
      // "something went wrong" is the difference between a viewer who waits and
      // one who gives up on a channel that was never dead.
      return 'unreachable';
    case 'ERR_TOO_MANY_REDIRECTS':
      return 'gone';
    default:
      break;
  }

  if (status) return 'server';
  return 'unknown';
}

function verdictFor(details) {
  const reason = REASONS[details] || REASONS.unknown;
  return reason.verdict;
}

/** Whether a failure should move a channel closer to being hidden. */
function shouldCount(details) {
  return verdictFor(details) === 'hard';
}

/** A sentence a person can act on, rather than a network error code. */
function explain(details) {
  const reason = REASONS[details] || REASONS.unknown;
  return reason.say();
}

module.exports = { reasonFor, verdictFor, shouldCount, explain, REASONS };