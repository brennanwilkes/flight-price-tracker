'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { planSweep, graphKey, allGraphs } = require('../scraper/src/sweep/plan');

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

test('planSweep: a focus city\'s long hauls first (its country\'s other gateways too), due or not, not ones scraped within the hour', () => {
  const cfg = { origins: ['YVR'], core: ['TYO', 'OSA', 'ICN'], longCabins: ['J'], tiers: [{ kind: 'long', homes: ['YVR'], cities: 'core', lengths: [14], oneWay: true, maxAgeHours: 12 }] };
  const all = allGraphs(cfg, { pairs: {} });
  const state = Object.fromEntries(all.map((x) => [graphKey(x), ago(2)])); // none due (12 h)
  state['YVR-OSA-J-OW|0'] = ago(0.5); // scraped within the hour: not again
  const got = planSweep(cfg, state, { pairs: {} }, now, null, {}, ['TYO']);
  assert.deepStrictEqual(got.map((x) => x.routeId).sort(), ['OSA-YVR-J-OW', 'TYO-YVR-J-OW', 'YVR-OSA-J', 'YVR-TYO-J', 'YVR-TYO-J-OW'].sort());
  assert.ok(got.every((x) => x.focus));
});
