'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildTrips, addDays } = require('../frontend/app/build.js');

const D0 = '2027-10-01';
const day = (n) => addDays(D0, n);

/** Small fare world: lookups from plain tables. */
function world({ rt = {}, ow = {}, hops = {}, asiaRT = {} }) {
  return {
    homes: ['YVR'],
    cities: ['DAD', 'HAN', 'ICN', 'MNL'],
    anchors: { DAD: 0, HAN: 1 },
    departures: [D0],
    asiaRT: (from, to, out) => asiaRT[`${from}-${to}|${out}`] ?? [],
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
  // No night in Seoul either way: the trip's row is Da Nang, where it stays.
  const t = find(trips, 'hybrid', 'DAD', 'DAD');
  assert.strictEqual(t.total, 4270);
  assert.strictEqual(t.days, 14);
  assert.strictEqual(t.sameDay, true);
});

test('alts counts other date sets about the same price (business 2%, economy 5%), per month and overall', () => {
  const { similarCount } = require('../frontend/app/build.js');
  const sets = new Map([['YVR|hybrid|MNL|MNL', new Map([
    ['2027-09-05|2027-09-22', 4000], // the best
    ['2027-09-06|2027-09-23', 4080], // +2%: counts
    ['2027-09-07|2027-09-24', 4081], // just over
    ['2027-10-01|2027-10-18', 4010], // other month
  ])]]);
  const trip = { home: 'YVR', cls: 'hybrid', in: 'MNL', out: 'MNL', total: 4000, depart: '2027-09-05', ret: '2027-09-22' };
  assert.equal(similarCount(sets, trip, '2027-09'), 1);
  assert.equal(similarCount(sets, trip), 2);
  const eco = new Map([['YVR|economy|MNL|MNL', new Map([['2027-09-05|2027-09-22', 1000], ['2027-09-06|2027-09-23', 1050], ['2027-09-07|2027-09-24', 1051]])]]);
  assert.equal(similarCount(eco, { ...trip, cls: 'economy', total: 1000 }), 1);
});

test('isSafe: no flight on the day the previous one lands (long haul counted as landing day 1)', () => {
  const { isSafe } = require('../frontend/app/build.js');
  const hop = (date) => ({ from: 'A', to: 'B', date, price: 1 });
  assert.equal(isSafe('2027-09-01', [hop('2027-09-03'), hop('2027-09-08')], '2027-09-15'), true);
  assert.equal(isSafe('2027-09-01', [hop('2027-09-02')], '2027-09-15'), false); // hop on landing day
  assert.equal(isSafe('2027-09-01', [hop('2027-09-03'), hop('2027-09-03')], '2027-09-15'), false); // same-day chain
  assert.equal(isSafe('2027-09-01', [hop('2027-09-15')], '2027-09-15'), false); // home the day of the last hop
});

test('Vietnam open jaw: in at Hanoi, Hoi An overland (a ground day each way from Hanoi), out of Da Nang', () => {
  const trips = buildTrips(world({
    ow: { [`YVR-HAN-Y|${D0}`]: 700, [`DAD-YVR-Y|${day(15)}`]: 800 },
    hops: {},
  }));
  // Landed day 1 in Hanoi, 1 day overland, 5 nights, 0 days to Da Nang: free from day 7 on.
  const t = find(trips, 'economy', 'HAN', 'DAD');
  assert.strictEqual(t.total, 1500);
  assert.deepStrictEqual(t.order, [[0, 'out'], [1, 'out']]);
  // Returning from Hanoi instead: the ground days count against the stay, still 1 + 1 + 5 + 1 ≤ 14.
  const back = buildTrips(world({ ow: { [`YVR-HAN-Y|${D0}`]: 700, [`HAN-YVR-Y|${day(14)}`]: 800 } }));
  assert.strictEqual(find(back, 'economy', 'HAN', 'HAN').total, 1500);
});

test('a return inside Asia, nested in the long-haul return, beats two one-ways', () => {
  const trips = buildTrips(world({
    rt: { [`YVR-MNL-Y|${D0}`]: [{ ret: day(17), price: 900 }] },
    hops: { [`MNL-DAD|${day(2)}`]: 150, [`DAD-MNL|${day(10)}`]: 150 },
    asiaRT: { [`MNL-DAD|${day(2)}`]: [{ ret: day(10), price: 180 }] },
  }));
  const t = find(trips, 'economy', 'MNL', 'MNL');
  assert.strictEqual(t.total, 1080);
  assert.deepStrictEqual(t.tickets.map((x) => `${x.kind} ${x.from}-${x.to}`), ['rt YVR-MNL', 'rt MNL-DAD']);
  assert.deepStrictEqual(t.order, [[0, 'out'], [1, 'out'], [1, 'back'], [0, 'back']]);
});

test('a nested return has to be flown on its day: too short for the Hoi An stay, no trip', () => {
  const trips = buildTrips(world({
    rt: { [`YVR-MNL-Y|${D0}`]: [{ ret: day(17), price: 900 }] },
    asiaRT: { [`MNL-DAD|${day(2)}`]: [{ ret: day(5), price: 100 }] },
  }));
  assert.strictEqual(find(trips, 'economy', 'MNL', 'MNL'), undefined);
});

test('the Hoi An stay is checked against real flights: an overnight flight in leaves it short', async () => {
  const { addDetails } = require('../scraper/src/trips/details');
  const [t] = buildTrips(world({
    rt: { [`YVR-ICN-Y|${D0}`]: [{ ret: day(14), price: 900 }] },
    hops: { [`ICN-DAD|${day(3)}`]: 200, [`DAD-ICN|${day(8)}`]: 180 },
  })).filter((x) => !x.via && x.cls === 'economy');
  assert.deepStrictEqual(t.stay, { after: 1, need: 5 });
  const opt = (from, to, depDate, arrDate, price) => ({ price, min: 300, airlines: ['X'], stops: [], legs: [{ code: 'X1', airline: 'X', from, to, dep: '10:00', arr: '15:00', depDate, arrDate, min: 300 }] });
  const run = async (dadArrives) => {
    const trip = structuredClone(t);
    const answers = {
      ICN: [opt('YVR', 'ICN', D0, day(1), 900)],
      DAD: [opt('ICN', 'DAD', day(3), dadArrives, 200)],
      back: [opt('DAD', 'ICN', day(8), day(8), 180)],
      home: [opt('ICN', 'YVR', day(14), day(14), 0)],
    };
    const cache = new Map();
    const { flightsOf } = require('../scraper/src/trips/details');
    for (const f of flightsOf(trip)) {
      const k = f.dir === 'back' ? 'home' : f.query.to === 'ICN' && f.query.from === 'YVR' ? 'ICN' : f.query.to === 'DAD' ? 'DAD' : 'back';
      cache.set(JSON.stringify(f.query), Promise.resolve(answers[k]));
    }
    const stats = await addDetails([trip], cache);
    return { connects: trip.connects, stay: stats.stay };
  };
  assert.deepStrictEqual(await run(day(3)), { connects: true, stay: 0 });
  assert.deepStrictEqual(await run(day(4)), { connects: false, stay: 1 }); // lands next day: 4 nights
});

test('stay ranges: a hop that can move a few days at about the same price widens the stays around it', () => {
  const hops = { [`ICN-DAD|${day(3)}`]: 200, [`DAD-ICN|${day(8)}`]: 180 };
  for (let n = 9; n <= 11; n++) hops[`DAD-ICN|${day(n)}`] = 185; // within 5% (economy) of a 1280 total
  hops[`DAD-ICN|${day(12)}`] = 400;
  hops[`ICN-DAD|${day(1)}`] = 260; // over day 3 by more than its shape penalties (2 nights before Hoi An, Seoul at both ends: build.js)
  const fares = world({ rt: { [`YVR-ICN-Y|${D0}`]: [{ ret: day(14), price: 900 }] }, hops });
  const t = buildTrips(fares).find((x) => !x.via && x.cls === 'economy');
  const { flexOf } = require('../frontend/app/flex.js');
  // Stays: 0 = Seoul before Da Nang (lands day 1, hop day 3), 1 = Da Nang (5 nights), 2 = Seoul after.
  // Da Nang can't get shorter (Hoi An minimum). One flight moves at a time: the hop out can wait
  // until day 11 (Da Nang +3, Seoul after −3); the hop in can go 2 days early (Seoul before −2).
  assert.deepStrictEqual(flexOf(t, fares), [[0, 2, 0], [1, 0, 3], [2, 3, 0]]);
});

test('lowest ever: the ledger marks any-date and same-date lows, and only records checked cells', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { markLows } = require('../scraper/src/trips/lows');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lows-'));
  // Two tickets: the long return (total - 200) and a hop; the hop's price stays put.
  const cell = (total, depart, connects = true) => ({ total, depart, ret: addDays(depart, 14), connects, tickets: [
    { kind: 'rt', cabin: 'J', from: 'YVR', to: 'MNL', date: depart, ret: addDays(depart, 14), price: total - 200 },
    { kind: 'ow', cabin: 'Y', from: 'MNL', to: 'DAD', date: addDays(depart, 2), price: 200 },
  ] });
  const row = (trip) => ({ in: 'MNL', out: 'MNL', hybrid: trip, economy: null, months: {} });
  const at = '2026-11-01T00:00:00Z';
  markLows(dir, { YVR: [row(cell(4000, '2027-09-01'))] }, at);
  markLows(dir, { YVR: [row(cell(3900, '2027-09-05'))] }, at);
  markLows(dir, { YVR: [row(cell(3000, '2027-09-09', false))] }, at); // not checked: not recorded
  const r = row(cell(4100, '2027-09-01'));
  markLows(dir, { YVR: [r] }, at, { record: false });
  assert.deepStrictEqual(r.hybrid.low, { any: { total: 3900, depart: '2027-09-05', ret: '2027-09-19' }, same: { total: 4000, at } });
  // Per ticket: the long return went up on these dates (it moved the total); the hop didn't.
  assert.deepStrictEqual(r.hybrid.tickets[0].low, { any: { total: 3700, dates: '2027-09-05,2027-09-19' }, same: { total: 3800, at } });
  assert.deepStrictEqual(r.hybrid.tickets[1].low, { any: { total: 200, dates: '2027-09-03' }, same: { total: 200, at } });
});

test('multi-city: two long one-ways become one open-jaw ticket, flights and order carried over', () => {
  const { merge, groupsOf } = require('../scraper/src/trips/multi');
  const [t] = buildTrips(world({
    ow: { [`YVR-ICN-J|${D0}`]: 3000, [`DAD-YVR-J|${day(15)}`]: 3200 },
    hops: { [`ICN-DAD|${day(3)}`]: 200 },
  })).filter((x) => !x.via && x.cls === 'hybrid');
  t.tickets[0].flights = { out: { legs: ['a'] } };
  const [g] = groupsOf(t, ['YVR']);
  assert.deepStrictEqual(g.replace, [0, 2]);
  merge(t, g, 4500);
  assert.deepStrictEqual(t.tickets.map((x) => `${x.kind} ${x.from}-${x.to} ${x.price}`), ['multi YVR-YVR 4500', 'ow ICN-DAD 200']);
  assert.deepStrictEqual(t.order, [[0, 'leg0'], [1, 'out'], [0, 'leg1']]);
  assert.deepStrictEqual(t.tickets[0].flights, { leg0: { legs: ['a'] } });
  assert.strictEqual(t.total, 4700);
  assert.match(t.tickets[0].url, /tfs=/);
});

test('need: only trips with a night in every listed city, the cheapest of those', () => {
  const w = world({
    rt: { [`YVR-ICN-J|${D0}`]: [{ ret: day(16), price: 4000 }] },
    hops: {
      [`ICN-DAD|${day(3)}`]: 100,
      [`DAD-ICN|${day(8)}`]: 100, // cheapest: never in Manila
      [`DAD-MNL|${day(8)}`]: 150,
      [`MNL-ICN|${day(9)}`]: 150, // a night in Manila
      [`MNL-ICN|${day(8)}`]: 10, // same day through Manila: changes planes, no night
    },
  });
  const all = find(buildTrips(w), 'hybrid', 'ICN', 'ICN');
  assert.strictEqual(all.total, 4200);
  const trips = buildTrips(w, { need: ['MNL'] });
  const t = find(trips, 'hybrid', 'ICN', 'ICN');
  assert.strictEqual(t.total, 4400);
  assert.ok(trips.every((x) => !x.via));
  assert.strictEqual(buildTrips(w, { need: ['MNL', 'HAN'] }).length, 0);
});

test('flights are picked together: a cheaper long haul landing later wins if the next flight still connects', async () => {
  const { addDetails, flightsOf } = require('../scraper/src/trips/details');
  const leg = (from, to, depDate, dep, arrDate, arr, price, airline) => ({ price, min: 0, airlines: [airline], stops: [], legs: [{ code: `${airline}1`, airline, from, to, dep, arr, depDate, arrDate, min: 0 }] });
  const trip = {
    order: [[0, 'out'], [1, 'out']],
    tickets: [
      { kind: 'ow', cabin: 'J', from: 'YVR', to: 'BKK', date: '2027-09-01', price: 5100 },
      { kind: 'ow', cabin: 'Y', from: 'BKK', to: 'HAN', date: '2027-09-03', price: 232 },
    ],
  };
  const answers = [
    [leg('YVR', 'BKK', '2027-09-01', '14:00', '2027-09-02', '23:00', 5220, 'JL'), leg('YVR', 'BKK', '2027-09-01', '23:55', '2027-09-03', '12:05', 5066, 'PR')],
    [leg('DMK', 'HAN', '2027-09-03', '06:40', '2027-09-03', '08:30', 232, 'FD'), leg('BKK', 'HAN', '2027-09-03', '17:00', '2027-09-03', '19:00', 260, 'VN')],
  ];
  const cache = new Map(flightsOf(trip).map((f, i) => [JSON.stringify(f.query), Promise.resolve(answers[i])]));
  await addDetails([trip], cache);
  assert.deepStrictEqual(trip.tickets.map((t) => t.flights.out.airlines[0]), ['PR', 'VN']);
  assert.strictEqual(trip.total, 5326);
});

test('ticket ▲/▼: its price 24 h before, from state/ticket-prices.json', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { markLows } = require('../scraper/src/trips/lows');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
  const cell = (price) => ({ total: price, depart: '2027-09-01', ret: '2027-09-15', connects: true, tickets: [
    { kind: 'ow', cabin: 'Y', from: 'YVR', to: 'MNL', date: '2027-09-01', price },
  ] });
  const run = (price, at) => { const r = { in: 'MNL', out: 'MNL', hybrid: cell(price), economy: null, months: {} }; markLows(dir, { YVR: [r] }, at); return r.hybrid.tickets[0].was; };
  assert.strictEqual(run(1200, '2026-11-01T00:00:00Z'), undefined);
  assert.strictEqual(run(1250, '2026-11-01T12:00:00Z'), undefined); // nothing a day old yet
  assert.strictEqual(run(1231, '2026-11-02T06:00:00Z'), 1200); // in force 24 h before: the first price
  assert.strictEqual(run(1231, '2026-11-02T13:00:00Z'), 1250);
  assert.strictEqual(run(1231, '2026-11-05T00:00:00Z'), undefined); // unchanged for days: no change shown
});

test('trip shape, at about the same price: Hoi An first, then the other city (C)', () => {
  // Seoul 6 nights then Hoi An, or Hoi An then Seoul 6 nights: same price, Hoi An first wins.
  const fares = (first) => world({
    rt: { [`YVR-ICN-Y|${D0}`]: [{ ret: day(14), price: 900 }] },
    hops: { [`ICN-DAD|${day(1)}`]: 200 + first, [`DAD-ICN|${day(7)}`]: 200, [`ICN-DAD|${day(7)}`]: 200, [`DAD-ICN|${day(13)}`]: 200 },
  });
  const hops = (t) => t.tickets.slice(1).map((k) => `${k.from}-${k.to} ${k.date}`);
  const pick = (first) => buildTrips(fares(first)).find((x) => !x.via && x.cls === 'economy');
  assert.strictEqual(hops(pick(0))[0], `ICN-DAD ${day(1)}`); // straight to Hoi An
  // Hoi An first $40 dearer: more than 6 nights' worth of the preference, so price wins.
  assert.deepStrictEqual(hops(pick(40)), [`ICN-DAD ${day(7)}`, `DAD-ICN ${day(13)}`]);
});

test('trip shape: 2+ nights in the hub at both ends counts against a trip (B)', () => {
  // Seoul 3 nights first either way (no earlier flight to Vietnam). After Hoi An: back to Seoul for
  // 3 nights, or Manila then home through Seoul the same day: $20 more, but Seoul at only one end.
  const t = buildTrips(world({
    rt: { [`YVR-ICN-Y|${D0}`]: [{ ret: day(14), price: 900 }] },
    hops: { [`ICN-DAD|${day(4)}`]: 180, [`DAD-ICN|${day(11)}`]: 180, [`DAD-MNL|${day(10)}`]: 100, [`MNL-ICN|${day(14)}`]: 100 },
  })).find((x) => !x.via && x.cls === 'economy');
  assert.deepStrictEqual(t.tickets.slice(1).map((k) => `${k.from}-${k.to}`), ['ICN-DAD', 'DAD-MNL', 'MNL-ICN']);
  assert.strictEqual(t.total, 900 + 380);
});

test('flights at about the same price: a short connection on a ticket beats a long one (A)', async () => {
  const { addDetails, flightsOf } = require('../scraper/src/trips/details');
  const opt = (price, layover) => ({ price, min: 0, airlines: ['PR'], stops: [{ at: 'MNL', min: layover }], legs: [
    { code: 'PR1', airline: 'PR', from: 'YVR', to: 'MNL', dep: '10:00', arr: '15:00', depDate: '2027-09-01', arrDate: '2027-09-02', min: 0 },
    { code: 'PR2', airline: 'PR', from: 'MNL', to: 'BKK', dep: '18:00', arr: '20:00', depDate: '2027-09-03', arrDate: '2027-09-03', min: 0 },
  ] });
  const run = async (opts) => {
    const trip = { order: [[0, 'out']], tickets: [{ kind: 'ow', cabin: 'J', from: 'YVR', to: 'BKK', date: '2027-09-01', price: 5000 }] };
    const cache = new Map(flightsOf(trip).map((f) => [JSON.stringify(f.query), Promise.resolve(opts)]));
    await addDetails([trip], cache);
    return trip.tickets[0].price;
  };
  assert.strictEqual(await run([opt(5000, 22 * 60), opt(5060, 3 * 60)]), 5060); // 1.2% more, 19 h less
  assert.strictEqual(await run([opt(5000, 22 * 60), opt(5200, 3 * 60)]), 5000); // 4% more: price wins
});

test('stay ranges: the long flight home can move too, the trip kept 14–21 days', () => {
  const fares = world({
    ow: { [`YVR-ICN-Y|${D0}`]: 500, [`ICN-YVR-Y|${day(14)}`]: 500, [`ICN-YVR-Y|${day(15)}`]: 510, [`ICN-YVR-Y|${day(16)}`]: 530, [`ICN-YVR-Y|${day(17)}`]: 600 },
    hops: { [`ICN-DAD|${day(3)}`]: 200, [`DAD-ICN|${day(8)}`]: 180 },
  });
  const t = buildTrips(fares).find((x) => !x.via && x.cls === 'economy');
  const { flexOf } = require('../frontend/app/flex.js');
  // The last stay (Seoul, before flying home): 2 more nights within 5% of $1,380; never shorter
  // than a 14-day trip.
  assert.deepStrictEqual(flexOf(t, fares).find(([k]) => k === 2), [2, 0, 2]);
});
