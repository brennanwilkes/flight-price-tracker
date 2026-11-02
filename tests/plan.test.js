'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { planSweep, graphKey } = require('../scraper/src/sweep/plan');

const config = {
  origins: ['YVR'], core: ['ICN'], longCabins: ['Y'],
  tiers: [{ kind: 'long', homes: ['YVR'], cities: 'core', lengths: [14], maxAgeHours: 2 }],
};
const g = { routeId: 'YVR-ICN-Y', tripLen: 14 };
const now = Date.parse('2026-11-02T12:00:00Z');
const ago = (h) => new Date(now - h * 3600e3).toISOString();

test('planSweep: a failing graph waits its max age, doubling per failure, not the front of every sweep', () => {
  const plan = (fails, state = {}) => planSweep(config, state, { pairs: {} }, now, null, fails).some((x) => graphKey(x) === graphKey(g));
  assert.ok(plan({}), 'never scraped: due');
  assert.ok(!plan({ [graphKey(g)]: { n: 1, at: ago(1) } }), 'failed an hour ago: waits 2 h');
  assert.ok(plan({ [graphKey(g)]: { n: 1, at: ago(2) } }));
  assert.ok(!plan({ [graphKey(g)]: { n: 3, at: ago(7) } }), 'third failure: waits 8 h');
  assert.ok(plan({ [graphKey(g)]: { n: 3, at: ago(8) } }));
  assert.ok(plan({ [graphKey(g)]: { n: 20, at: ago(24 * 7) } }), 'capped at a week');
});
