'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findDeals, isNews, tierOf } = require('../scraper/src/alerts/rules');

const config = {
  tiers: { hybrid: [[3500, 'buy'], [4200, 'great']], economy: [[800, 'buy']] },
  cheapBusinessLongLegs: 3000, newLowWarmupDays: 14, realertDrop: { cad: 100, share: 0.05 },
};
const trip = (total, jPrice, connects = true) => ({
  total, connects, depart: '2027-09-01', ret: '2027-09-15', days: 14,
  tickets: [{ kind: 'rt', cabin: 'J', price: jPrice }, { kind: 'ow', cabin: 'Y', price: total - jPrice }],
});
const now = '2026-12-01T00:00:00Z';

test('deals: buy tier, cheap business long legs, new low after warm-up; never a trip that misses a connection', () => {
  const rows = { YVR: [
    { in: 'MNL', out: 'MNL', hybrid: trip(3400, 3200), economy: null },        // buy
    { in: 'ICN', out: 'ICN', hybrid: trip(4100, 2900), economy: null },        // cheap-j
    { in: 'HKG', out: 'HKG', hybrid: trip(4500, 4300), economy: null },        // new low (history 4600 since Nov 1)
    { in: 'SIN', out: 'SIN', hybrid: trip(4500, 4300), economy: null },        // history too young
    { in: 'BKK', out: 'BKK', hybrid: trip(3000, 2800, false), economy: null }, // doesn't connect
  ] };
  const history = new Map([
    ['YVR,hybrid,HKG,HKG', { low: 4600, first: '2026-11-01T00:00:00Z' }],
    ['YVR,hybrid,SIN,SIN', { low: 4600, first: '2026-11-25T00:00:00Z' }],
  ]);
  const deals = findDeals(config, rows, history, now);
  assert.deepEqual(deals.map((d) => [d.in, d.reasons]), [['MNL', ['buy']], ['ICN', ['cheap-j']], ['HKG', ['new-low']]]);
});

test('re-alert only on a further $100 / 5% drop or a better tier', () => {
  const d = (total) => ({ trip: { total }, tier: tierOf(config, 'hybrid', total) });
  assert.equal(isNews(config, d(3400), undefined), true);
  assert.equal(isNews(config, d(3350), { total: 3400, tier: 'buy' }), false);
  assert.equal(isNews(config, d(3230), { total: 3400, tier: 'buy' }), true); // 5% of 3400 = 170
  assert.equal(isNews(config, d(3450), { total: 3600, tier: 'great' }), true); // tier up
});
