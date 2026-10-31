'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildTrips, addDays } = require('../scraper/src/trips/build');

const D0 = '2027-10-01';
const day = (n) => addDays(D0, n);

/** Small fare world: lookups from plain tables. */
function world({ rt = {}, ow = {}, hops = {} }) {
  return {
    homes: ['YVR'],
    cities: ['DAD', 'ICN', 'MNL'],
    departures: [D0],
    roundTrip: (home, city, cabin, out) => rt[`${home}-${city}-${cabin}|${out}`] ?? [],
    oneWay: (from, to, cabin, date) => ow[`${from}-${to}-${cabin}|${date}`] ?? null,
    hop: (from, to, date) => hops[`${from}-${to}|${date}`] ?? null,
  };
}
const find = (trips, cls, i, o) => trips.find((t) => !t.via && t.cls === cls && t.in === i && t.out === o);

test('round trip to a city needs hops into and out of Da Nang for 5 nights', () => {
  const trips = buildTrips(world({
    rt: { [`YVR-ICN-J|${D0}`]: [{ ret: day(14), price: 4000 }] },
    hops: {
      [`ICN-DAD|${day(3)}`]: 200,
      [`DAD-ICN|${day(7)}`]: 150, // only 4 nights: not enough
      [`DAD-ICN|${day(8)}`]: 180,
    },
  }));
  const t = find(trips, 'hybrid', 'ICN', 'ICN');
  assert.strictEqual(t.total, 4380);
  assert.deepStrictEqual(t.tickets.map((k) => `${k.from}-${k.to} ${k.date}`), [
    `YVR-ICN ${D0}`, `ICN-DAD ${day(3)}`, `DAD-ICN ${day(8)}`,
  ]);
  assert.strictEqual(t.sameDay, false);
  assert.strictEqual(find(trips, 'economy', 'ICN', 'ICN'), undefined); // no economy long legs priced
});

test('open jaw: in one city, home from another; cheapest wins; cabins never mixed', () => {
  const trips = buildTrips(world({
    ow: {
      [`YVR-DAD-J|${D0}`]: 2500,
      [`MNL-YVR-J|${day(15)}`]: 2000,
      [`DAD-YVR-J|${day(15)}`]: 3000,
      [`MNL-YVR-Y|${day(15)}`]: 500, // economy back must not pair with business out
    },
    hops: { [`DAD-MNL|${day(10)}`]: 120 },
  }));
  assert.strictEqual(find(trips, 'hybrid', 'DAD', 'MNL').total, 4620);
  assert.strictEqual(find(trips, 'hybrid', 'DAD', 'DAD').total, 5500);
  assert.ok(!trips.some((t) => t.cls === 'economy'));
  assert.ok(trips.every((t) => t.tickets.every((k) => k.cabin === (k.from === 'YVR' || k.to === 'YVR' ? 'J' : 'Y'))));
});

test('same-day connection is allowed but marked; trip length stays within 14-21 days', () => {
  const trips = buildTrips(world({
    rt: { [`YVR-ICN-J|${D0}`]: [{ ret: day(13), price: 100 }, { ret: day(14), price: 4000 }] },
    hops: {
      [`ICN-MNL|${day(1)}`]: 90, // the day the Pacific flight lands
      [`MNL-DAD|${day(1)}`]: 80, // and on again the same day
      [`DAD-ICN|${day(14)}`]: 100, // the day the flight home leaves
    },
  }));
  const t = find(trips, 'hybrid', 'ICN', 'ICN');
  assert.strictEqual(t.total, 4270);
  assert.strictEqual(t.days, 14);
  assert.strictEqual(t.sameDay, true);
});

test('alts counts other date sets within 2% of the best, per month and overall', () => {
  const { similarCount } = require('../scraper/src/trips/build');
  const sets = new Map([['YVR|hybrid|MNL|MNL', new Map([
    ['2027-09-05|2027-09-22', 4000], // the best
    ['2027-09-06|2027-09-23', 4080], // +2%: counts
    ['2027-09-07|2027-09-24', 4081], // just over
    ['2027-10-01|2027-10-18', 4010], // other month
  ])]]);
  const trip = { home: 'YVR', cls: 'hybrid', in: 'MNL', out: 'MNL', total: 4000, depart: '2027-09-05', ret: '2027-09-22' };
  assert.equal(similarCount(sets, trip, '2027-09'), 1);
  assert.equal(similarCount(sets, trip), 2);
});

test('isSafe: no flight on the day the previous one lands (long haul counted as landing day 1)', () => {
  const { isSafe } = require('../scraper/src/trips/build');
  const hop = (date) => ({ from: 'A', to: 'B', date, price: 1 });
  assert.equal(isSafe('2027-09-01', [hop('2027-09-03'), hop('2027-09-08')], '2027-09-15'), true);
  assert.equal(isSafe('2027-09-01', [hop('2027-09-02')], '2027-09-15'), false); // hop on landing day
  assert.equal(isSafe('2027-09-01', [hop('2027-09-03'), hop('2027-09-03')], '2027-09-15'), false); // same-day chain
  assert.equal(isSafe('2027-09-01', [hop('2027-09-15')], '2027-09-15'), false); // home the day of the last hop
});
