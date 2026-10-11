'use strict';

const test = require('node:test');
const assert = require('node:assert');

const health = require('../src/channel-health');

test('a stream that is genuinely gone is a hard failure', () => {
  for (const details of ['dns', 'refused', 'gone', 'notManifest', 'noSegments']) {
    assert.strictEqual(health.verdictFor(details), 'hard', details);
    assert.strictEqual(health.shouldCount(details), true, details);
  }
});

test('a timeout never counts', () => {
  // This is the rule that stops a bad network moment hiding a channel that is
  // perfectly alive.
  assert.strictEqual(health.verdictFor('timeout'), 'soft');
  assert.strictEqual(health.shouldCount('timeout'), false);
});

test('a geo-block is not a dead channel', () => {
  assert.strictEqual(health.verdictFor('blocked'), 'soft');
  assert.strictEqual(health.shouldCount('blocked'), false);
  assert.match(health.explain('blocked'), /blocked in this region/i);
});

test('an unroutable address is a network problem, not a dead channel', () => {
  // EHOSTUNREACH says the route is missing, not that the channel has gone.
  for (const code of ['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN']) {
    assert.strictEqual(health.shouldCount(health.reasonFor({ code })), false, code);
  }
  assert.match(health.explain('unreachable'), /cannot be reached/i);
});

test('a reset or a server error does not count', () => {
  for (const details of ['reset', 'server', 'refusedPlay', 'unknown']) {
    assert.strictEqual(health.shouldCount(details), false, details);
  }
});

test('network codes map to the right verdict', () => {
  assert.strictEqual(health.reasonFor({ code: 'ENOTFOUND' }), 'dns');
  assert.strictEqual(health.reasonFor({ code: 'ECONNREFUSED' }), 'refused');
  assert.strictEqual(health.reasonFor({ code: 'ETIMEDOUT' }), 'timeout');
  assert.strictEqual(health.reasonFor({ code: 'ECONNRESET' }), 'reset');
  assert.strictEqual(health.reasonFor({ code: 'EAI_AGAIN' }), 'reset');
});

test('http statuses map to the right verdict', () => {
  assert.strictEqual(health.reasonFor({ status: 404 }), 'gone');
  assert.strictEqual(health.reasonFor({ status: 410 }), 'gone');
  assert.strictEqual(health.reasonFor({ status: 403 }), 'blocked');
  assert.strictEqual(health.reasonFor({ status: 503 }), 'server');
});

test('a body that is not a manifest is hard, and a manifest with no segments too', () => {
  assert.strictEqual(health.reasonFor({ body: 'not a manifest' }), 'notManifest');
  assert.strictEqual(health.reasonFor({ body: 'no segments' }), 'noSegments');
  assert.strictEqual(health.shouldCount('notManifest'), true);
  assert.strictEqual(health.shouldCount('noSegments'), true);
});

test('every reason has a sentence a person can read', () => {
  for (const key of Object.keys(health.REASONS)) {
    if (key === 'ok') continue;
    const text = health.explain(key);
    assert.ok(text && text.length > 12, `${key} has no explanation`);
    assert.doesNotMatch(text, /undefined|\[object/, `${key} leaks an implementation detail`);
  }
});

test('an unknown failure is soft, so an unrecognised error cannot hide a channel', () => {
  // Failing open is the safe direction: wrongly hiding a working channel is much
  // worse than showing a dead one for a while longer.
  assert.strictEqual(health.verdictFor('something-new'), 'soft');
  assert.strictEqual(health.shouldCount('something-new'), false);
});