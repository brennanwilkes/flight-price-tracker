'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildTrips, nearestStay, reentersVietnam, scoreOf, addDays } = require('../frontend/app/build.js');

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
const find = (trips, cls, i, o, set = '') => trips.find((t) => !t.via && t.cls === cls && t.in === i && t.out === o && t.set === set);

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
  // No night in Seoul either way: still its row, the crossing (Da Nang is Hoi An's, never named).
  const t = find(trips, 'hybrid', 'ICN', 'ICN');
  assert.strictEqual(t.total, 4270);
  assert.strictEqual(t.days, 14);
  assert.strictEqual(t.sameDay, true);
});

test('alts counts other date sets about the same price (business 2%, economy 5%), per month and overall', () => {
  const { similarCount } = require('../frontend/app/build.js');
  // As buildTrips keeps them: route → month → (day number × 64 + length) → cheapest total.
  const table = (route, list) => {
    const months = new Map();
    for (const [depart, ret, total] of list) {
      const m = months.get(depart.slice(0, 7)) ?? new Map();
      m.set((Date.parse(depart) / 864e5) * 64 + (Date.parse(ret) - Date.parse(depart)) / 864e5, total);
      months.set(depart.slice(0, 7), m);
    }
    return new Map([[route, months]]);
  };
  const sets = table('YVR|hybrid|MNL|MNL|', [
    ['2027-09-05', '2027-09-22', 4000], // the best
    ['2027-09-06', '2027-09-23', 4080], // +2%: counts
    ['2027-09-07', '2027-09-24', 4081], // just over
    ['2027-10-01', '2027-10-18', 4010], // other month
  ]);
  const trip = { home: 'YVR', cls: 'hybrid', in: 'MNL', out: 'MNL', set: '', total: 4000, depart: '2027-09-05', ret: '2027-09-22' };
  assert.equal(similarCount(sets, trip, '2027-09'), 1);
  assert.equal(similarCount(sets, trip), 2);
  const eco = table('YVR|economy|MNL|MNL|', [['2027-09-05', '2027-09-22', 1000], ['2027-09-06', '2027-09-23', 1050], ['2027-09-07', '2027-09-24', 1051]]);
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
  // Hoi An first $60 dearer: more than Seoul first's penalties (6 nights before Hoi An, one night
  // in Seoul at the end: $49), so price wins.
  assert.deepStrictEqual(hops(pick(60)), [`ICN-DAD ${day(7)}`, `DAD-ICN ${day(13)}`]);
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

test('trip shape: a single overnight between flights counts against a trip', () => {
  // Into Hoi An from Seoul after 1 night, or after 2 nights for $10 more: 2 nights wins.
  const t = buildTrips(world({
    rt: { [`YVR-ICN-Y|${D0}`]: [{ ret: day(14), price: 900 }] },
    hops: { [`ICN-DAD|${day(2)}`]: 190, [`ICN-DAD|${day(3)}`]: 200, [`DAD-ICN|${day(13)}`]: 180 }, // back for 1 night: no hub at both ends
  })).find((x) => !x.via && x.cls === 'economy');
  assert.strictEqual(t.tickets[1].date, day(3));
});

test('rows: the crossing plus the other cities slept in 2+ nights, Vietnam named only when it is all there is', async () => {
  const { setOf, rowId } = require('../frontend/app/build.js');
  const { rowName } = await import('../frontend/app/cities.js');
  assert.strictEqual(setOf({ nights: { HAN: 3, BKK: 2, DAD: 5, MNL: 1 }, x: 'ICN', y: 'ICN' }), 'BKK');
  assert.strictEqual(setOf({ nights: { SIN: 2, BKK: 4 }, x: 'BKK', y: 'DPS' }), 'SIN');
  assert.strictEqual(setOf({ nights: { HAN: 3 }, x: 'ICN', y: 'SGN' }), '');
  assert.strictEqual(setOf({ nights: { HAN: 3, DAD: 5, PQC: 2 }, x: 'SGN', y: 'SGN' }), 'HAN+PQC');
  const r = { in: 'BKK', out: 'DPS', set: 'SIN+HAN' };
  assert.strictEqual(rowId(r), 'BKK-DPS+SIN+HAN');
  assert.strictEqual(rowName(r), 'Bangkok / Bali + Hanoi + Singapore');
  assert.strictEqual(rowName({ in: 'MNL', out: 'MNL', set: '' }), 'Manila');
});

test('rows: a crossing gets a row through another city even when that costs more than its cheapest', () => {
  const trips = buildTrips(world({
    rt: { [`YVR-ICN-J|${D0}`]: [{ ret: day(14), price: 4000 }] },
    hops: {
      [`ICN-DAD|${day(3)}`]: 200,
      [`DAD-ICN|${day(8)}`]: 180, // the cheapest: straight back to Seoul
      [`DAD-MNL|${day(8)}`]: 100,
      [`MNL-ICN|${day(11)}`]: 150, // or 3 nights in Manila first
    },
  }));
  assert.strictEqual(find(trips, 'hybrid', 'ICN', 'ICN').total, 4380);
  const t = find(trips, 'hybrid', 'ICN', 'ICN', 'MNL');
  assert.strictEqual(t.total, 4450);
  assert.deepStrictEqual(t.tickets.slice(1).map((k) => `${k.from}-${k.to}`), ['ICN-DAD', 'DAD-MNL', 'MNL-ICN']);
});

test('rows: a city never among the cheapest ways through still gets a row', () => {
  const via = (c, price) => ({ [`DAD-${c}|${day(8)}`]: price, [`${c}-ICN|${day(11)}`]: price });
  const trips = buildTrips({ ...world({
    rt: { [`YVR-ICN-J|${D0}`]: [{ ret: day(14), price: 4000 }] },
    hops: {
      [`ICN-DAD|${day(3)}`]: 200,
      ...via('MNL', 100), ...via('CEB', 100), ...via('SIN', 100), ...via('HKG', 100), ...via('TPE', 100),
      ...via('PEN', 300), // dearer than all five
    },
  }), cities: ['DAD', 'HAN', 'ICN', 'MNL', 'CEB', 'SIN', 'HKG', 'TPE', 'PEN'] });
  assert.strictEqual(find(trips, 'hybrid', 'ICN', 'ICN', 'PEN').total, 4800);
});

test('the Hoi An stay goes with the nearest Vietnam city that has the days: Da Nang over Hanoi', () => {
  // Hanoi 7 days, Seoul a night, then Da Nang 6: planned from Hanoi, moved to Da Nang (no ground days).
  const flights = [
    { kind: 'ow', from: 'MNL', to: 'HAN', date: day(2), price: 100 },
    { kind: 'ow', from: 'HAN', to: 'ICN', date: day(9), price: 100 },
    { kind: 'ow', from: 'ICN', to: 'DAD', date: day(10), price: 100 },
    { kind: 'ow', from: 'DAD', to: 'MNL', date: day(16), price: 100 },
  ];
  const stay = (at, need, i) => [...flights.slice(0, i), { kind: 'stay', from: at, to: at, need }, ...flights.slice(i)];
  const anchors = { DAD: 0, HAN: 1 };
  assert.deepStrictEqual(nearestStay('MNL', D0, stay('HAN', 7, 1), 17, anchors), stay('DAD', 5, 3));
  // Da Nang 4 nights only: stays in Hanoi. An open jaw (in at one city, out of another) is kept.
  const short = flights.map((f) => (f.to === 'DAD' ? { ...f, date: day(12) } : f));
  assert.deepStrictEqual(nearestStay('MNL', D0, [...short.slice(0, 1), { kind: 'stay', from: 'HAN', to: 'HAN', need: 7 }, ...short.slice(1)], 17, anchors)[1].from, 'HAN');
  const jaw = [flights[0], { kind: 'stay', from: 'HAN', to: 'DAD', need: 6 }, flights[3]];
  assert.deepStrictEqual(nearestStay('MNL', D0, jaw, 17, anchors), jaw);
});

test('trip shape: flying into Vietnam a second time counts the whole tolerance against a trip', () => {
  const stay = { kind: 'stay', from: 'DAD', to: 'DAD', need: 5 };
  const via = (to) => [stay, { kind: 'ow', from: 'DAD', to: 'ICN', date: day(7) }, { kind: 'ow', from: 'ICN', to, date: day(12) }];
  assert.strictEqual(reentersVietnam('DAD', via('MNL')), false);
  assert.strictEqual(reentersVietnam('DAD', via('HAN')), true);
  assert.strictEqual(reentersVietnam('MNL', [{ kind: 'ow', from: 'MNL', to: 'HAN', date: day(2) }, stay]), false);
  // Capped at the tolerance: back into Vietnam wins only when more than 5% cheaper (economy).
  const trip = (total, reentry) => ({ cls: 'economy', total, pen: 0, reentry });
  assert.ok(scoreOf(trip(1000, true)) > scoreOf(trip(1040, false)));
  assert.ok(scoreOf(trip(1000, true)) < scoreOf(trip(1060, false)));
});

test('landing days: a hop that only flies overnight lands the next day, so the Hoi An stay starts then', () => {
  const fares = (lands) => ({
    ...world({
      rt: { [`YVR-MNL-Y|${D0}`]: [{ ret: day(14), price: 900 }] },
      hops: { [`MNL-DAD|${day(2)}`]: 100, [`DAD-MNL|${day(7)}`]: 100, [`DAD-MNL|${day(8)}`]: 150 },
    }),
    lands: (from, to, date) => lands[`${from}|${to}|${date}`] ?? null,
  });
  const back = (trips) => trips.find((t) => !t.via && t.cls === 'economy').tickets.find((k) => k.from === 'DAD').date;
  assert.strictEqual(back(buildTrips(fares({}))), day(7)); // lands day 2: 5 nights by day 7
  assert.strictEqual(back(buildTrips(fares({ [`MNL|DAD|${day(2)}`]: 1 }))), day(8)); // lands day 3
  // A long flight out landing two days on (every home's): the same, from the start.
  const late = buildTrips(fares({ [`YVR|MNL|${D0}`]: 2, [`MNL|DAD|${day(2)}`]: 0 }));
  assert.ok(late.some((t) => !t.via && t.cls === 'economy'));
  const t0 = buildTrips({ ...fares({ [`YVR|MNL|${D0}`]: 2 }), hop: (f, to, d) => ({ [`MNL-DAD|${day(1)}`]: 100, [`DAD-MNL|${day(7)}`]: 100 })[`${f}-${to}|${d}`] ?? null });
  assert.strictEqual(t0.length, 0); // landed day 2: no flight on day 1 to take
});

test('Pacific stop: the long haul broken up at Honolulu, nights there both ways, its own row', () => {
  const w = world({
    ow: {
      [`YVR-ICN-J|${D0}`]: 3000, // direct, both ways: the plain row
      [`ICN-YVR-J|${day(16)}`]: 3000,
      [`YVR-HNL-J|${day(-2)}`]: 700, // out two days early, two nights in Honolulu
      [`HNL-ICN-J|${D0}`]: 1500, // lands day 1, like a flight from home
      [`ICN-HNL-J|${day(16)}`]: 1400, // home the same way, a night there
      [`HNL-YVR-J|${day(17)}`]: 600,
    },
    hops: { [`ICN-DAD|${day(3)}`]: 200, [`DAD-ICN|${day(9)}`]: 180 },
  });
  w.pacific = ['HNL'];
  const trips = buildTrips(w);
  assert.strictEqual(find(trips, 'hybrid', 'ICN', 'ICN').total, 6380);
  const t = find(trips, 'hybrid', 'ICN', 'ICN', 'HNL');
  assert.strictEqual(t.total, 4580);
  assert.strictEqual(t.depart, day(-2));
  assert.strictEqual(t.ret, day(17));
  assert.strictEqual(t.days, 19);
  assert.deepStrictEqual(t.tickets.map((k) => `${k.from}-${k.to} ${k.date} ${k.cabin}`), [
    `YVR-HNL ${day(-2)} J`, `HNL-ICN ${D0} J`, `ICN-DAD ${day(3)} Y`, `DAD-ICN ${day(9)} Y`, `ICN-HNL ${day(16)} J`, `HNL-YVR ${day(17)} J`,
  ]);
  const { staysOf } = require('../frontend/app/build.js');
  assert.deepStrictEqual(staysOf(t, ['YVR']).nights.HNL, 3); // 2 out, 1 back
  // The via filter: the Honolulu trips, and a 'need' build finds them too.
  assert.ok(trips.some((x) => x.via === 'HNL' && x.set === 'HNL'));
  assert.strictEqual(buildTrips(w, { need: ['HNL'] }).filter((x) => !x.via).every((x) => x.set.includes('HNL')), true);
});

test('long-haul cap: the same trip re-picked from its searches with every long flight under the cap', async () => {
  const { addDetails, flightsOf, capped, longestOf } = require('../scraper/src/trips/details');
  const leg = (from, to, depDate, dep, arrDate, arr, price, airline, min) => ({ price, min, airlines: [airline], stops: [], legs: [{ code: `${airline}1`, airline, from, to, dep, arr, depDate, arrDate, min }] });
  // Through Taipei: 26 h door to door, but its longest flight is 13 h.
  const via = { ...leg('YVR', 'BKK', '2027-09-01', '01:00', '2027-09-02', '23:00', 4300, 'BR', 26 * 60), legs: [{ min: 13 * 60, from: 'YVR', to: 'TPE', dep: '01:00', depDate: '2027-09-01', arr: '05:00', arrDate: '2027-09-02' }, { min: 4 * 60, from: 'TPE', to: 'BKK', dep: '19:00', depDate: '2027-09-02', arr: '23:00', arrDate: '2027-09-02' }] };
  const trip = {
    order: [[0, 'out'], [1, 'out']],
    tickets: [
      { kind: 'ow', cabin: 'J', from: 'YVR', to: 'BKK', date: '2027-09-01', price: 4000 },
      { kind: 'ow', cabin: 'Y', from: 'BKK', to: 'HAN', date: '2027-09-05', price: 200 },
    ],
  };
  const answers = [
    [leg('YVR', 'BKK', '2027-09-01', '01:00', '2027-09-02', '23:00', 4000, 'PR', 26 * 60), leg('YVR', 'BKK', '2027-09-01', '12:00', '2027-09-02', '18:00', 4600, 'CX', 15 * 60), via],
    [leg('BKK', 'HAN', '2027-09-05', '06:40', '2027-09-05', '08:30', 200, 'VN', 15 * 60 + 50)], // a hop: never capped
  ];
  const cache = new Map(flightsOf(trip).map((f, i) => [JSON.stringify(f.query), Promise.resolve(answers[i])]));
  await addDetails([trip], cache);
  assert.strictEqual(longestOf(trip, ['YVR']), 26 * 60);
  assert.strictEqual((await capped(trip, cache, 16 * 60, ['YVR'])).tickets[0].flights.out.airlines[0], 'BR'); // cheaper than CX, no flight over 13 h
  const fast = await capped(trip, cache, 15 * 60, ['YVR']);
  assert.strictEqual(fast.tickets[0].flights.out.airlines[0], 'BR');
  assert.strictEqual(fast.total, 4500);
  assert.strictEqual(trip.total, 4200); // the cell's own trip unchanged
  assert.strictEqual((await capped(trip, cache, 14 * 60, ['YVR'])).tickets[0].flights.out.airlines[0], 'BR');
  assert.strictEqual(await capped(trip, cache, 12 * 60, ['YVR']), null);
});

test('Pacific stop: a round trip home ⇄ Honolulu holds the trip; one ticket through the stop is a grouping', () => {
  const w = world({
    rt: { [`YVR-HNL-J|${day(-1)}`]: [{ ret: day(17), price: 900 }] },
    ow: { [`HNL-ICN-J|${D0}`]: 1500, [`ICN-HNL-J|${day(16)}`]: 1400 },
    hops: { [`ICN-DAD|${day(3)}`]: 200, [`DAD-ICN|${day(9)}`]: 180 },
  });
  w.pacific = ['HNL'];
  const t = find(buildTrips(w), 'hybrid', 'ICN', 'ICN', 'HNL');
  assert.strictEqual(t.total, 4180);
  assert.deepStrictEqual(t.order.map(([i, dir]) => `${t.tickets[i].kind} ${dir}`), ['rt out', 'ow out', 'ow out', 'ow out', 'ow out', 'rt back']);
  assert.strictEqual(t.days, 18);
  const { groupsOf } = require('../scraper/src/trips/multi');
  const g = groupsOf(t, ['YVR']).find((x) => x.legs.length === 4);
  assert.deepStrictEqual(g.legs.map((l) => `${l.from}-${l.to}`), ['YVR-HNL', 'HNL-ICN', 'ICN-HNL', 'HNL-YVR']);
});

test('search slots: a job still queued when the deadline passes is dropped (Late), not run', async () => {
  const { slots, Late } = require('../scraper/src/trips/details');
  let ran = 0;
  const slow = () => new Promise((done) => setTimeout(() => { ran++; done([]); }, 60));
  const run = slots(new Map(), 'pages', 4);
  const deadline = Date.now() + 20;
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => run(0, deadline, slow)));
  assert.equal(ran, 4, 'the four with a slot run');
  assert.deepEqual(results.slice(4).map((r) => r.reason instanceof Late), [true, true]);
});

test('search slots: the waiting job with the lowest priority goes next', async () => {
  const { slots } = require('../scraper/src/trips/details');
  const run = slots(new Map(), 'plain', 1);
  const order = [];
  const job = (n) => () => new Promise((done) => setTimeout(() => { order.push(n); done(); }, 5));
  await Promise.all([run(0, Infinity, job('first')), run(30, Infinity, job('via')), run(9, Infinity, job('dashboard, 10th try')), run(1e6, Infinity, job('refresh'))]);
  assert.deepEqual(order, ['first', 'dashboard, 10th try', 'via', 'refresh']);
});

test('a stale search serves its flights at once, the fare keeping its own price, and nothing is listed from it', async () => {
  const { addDetails, flightsOf } = require('../scraper/src/trips/details');
  const leg = (from, to, depDate, price) => ({ price, min: 60, airlines: ['VN'], stops: [], legs: [{ code: 'VN1', airline: 'VN', from, to, dep: '08:00', arr: '09:00', depDate, arrDate: depDate, min: 60 }] });
  const trip = { order: [[0, 'out']], tickets: [{ kind: 'ow', cabin: 'Y', from: 'HAN', to: 'DAD', date: '2027-09-03', price: 80 }] };
  const [f] = flightsOf(trip);
  const cache = new Map();
  cache.stale = new Map([[JSON.stringify(f.query), [leg('HAN', 'DAD', '2027-09-03', 95)]]]);
  const listed = new Map();
  // Past the deadline: no search may start, the refresh among them.
  const s = await addDetails([trip], cache, null, listed, Date.now() - 1);
  assert.strictEqual(trip.connects, true);
  assert.strictEqual(trip.tickets[0].flights.out.legs[0].code, 'VN1');
  assert.strictEqual(trip.tickets[0].price, 80, 'the graph price stands');
  assert.strictEqual(listed.size, 0);
  assert.deepStrictEqual([s.searches, s.late], [0, 0]);
});

test('self-transfer: two one-ways connecting within 12 h become one ticket at about the same price, and count against the trip until then', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { applyMulti, groupsOf, multiSaving, SELF_PEN } = require('../scraper/src/trips/multi');
  const flight = (from, to, depDate, dep, arr) => ({ price: 0, min: 60, airlines: ['KE'], stops: [], legs: [{ code: 'KE1', airline: 'KE', from, to, dep, arr, depDate, arrDate: depDate, min: 60 }] });
  const trip = () => ({
    cls: 'economy',
    order: [[0, 'out'], [1, 'out']],
    tickets: [
      { kind: 'ow', cabin: 'Y', from: 'YVR', to: 'ICN', date: '2027-09-01', price: 700, flights: { out: flight('YVR', 'ICN', '2027-09-01', '01:00', '06:00') } },
      { kind: 'ow', cabin: 'Y', from: 'ICN', to: 'SGN', date: '2027-09-01', price: 300, flights: { out: flight('ICN', 'SGN', '2027-09-01', '12:00', '16:00') } },
    ],
  });
  const self = groupsOf(trip(), ['YVR']).filter((g) => g.self);
  assert.deepStrictEqual(self.map((g) => g.replace), [[0, 1]]);
  // Over 12 h between them: not a self-transfer.
  const apart = trip();
  apart.tickets[1].flights.out.legs[0].dep = '19:00';
  assert.strictEqual(groupsOf(apart, ['YVR']).filter((g) => g.self).length, 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-'));
  const run = async (listed) => {
    const t = trip();
    fs.rmSync(path.join(dir, 'state'), { recursive: true, force: true });
    // One GetShoppingResults row listed at `listed` (flights.js parseResults' layout).
    await applyMulti(dir, [t], ['YVR'], async () => [{ 2: [[[[null, ['KE'], [[]]], [[listed]]]]] }], { budget: 0 });
    return { t };
  };
  // $1,040 is within economy's 5% of $1,000: one ticket wins; $1,060 isn't.
  const same = await run(1040);
  assert.strictEqual(same.t.tickets.length, 1);
  assert.strictEqual(same.t.total, 1040);
  const dearer = await run(1060);
  assert.strictEqual(dearer.t.tickets.length, 2);
  // The ranking credits the one ticket with the self-transfer's penalty.
  assert.strictEqual(multiSaving({ [`Y YVR-ICN 2027-09-01, ICN-SGN 2027-09-01`]: { price: 1040 } }, trip(), ['YVR']), 1000 - 1040 + SELF_PEN);
});

test('no top flight connects: the flights leaving after the connection are searched plain, no browser', async () => {
  const { addDetails, flightsOf } = require('../scraper/src/trips/details');
  const leg = (from, to, depDate, dep, arrDate, arr, price, airline) => ({ price, min: 0, airlines: [airline], stops: [], legs: [{ code: `${airline}1`, airline, from, to, dep, arr, depDate, arrDate, min: 0 }] });
  const trip = {
    order: [[0, 'out'], [1, 'out']],
    tickets: [
      { kind: 'ow', cabin: 'J', from: 'YVR', to: 'BKK', date: '2027-09-01', price: 5100 },
      { kind: 'ow', cabin: 'Y', from: 'BKK', to: 'HAN', date: '2027-09-03', price: 232 },
    ],
  };
  const [a, b] = flightsOf(trip);
  const cache = new Map([
    [JSON.stringify(a.query), Promise.resolve([leg('YVR', 'BKK', '2027-09-01', '23:55', '2027-09-03', '12:05', 5066, 'PR')])],
    [JSON.stringify(b.query), Promise.resolve([leg('BKK', 'HAN', '2027-09-03', '06:40', '2027-09-03', '08:30', 232, 'FD')])],
    // 12:05 + 4 h: from 16:00
    [JSON.stringify({ ...b.query, after: 16 }), Promise.resolve([leg('BKK', 'HAN', '2027-09-03', '17:00', '2027-09-03', '19:00', 260, 'VN')])],
  ]);
  await addDetails([trip], cache);
  assert.strictEqual(trip.connects, true);
  assert.deepStrictEqual(trip.tickets.map((t) => t.flights.out.airlines[0]), ['PR', 'VN']);
  assert.strictEqual(cache.tally.window, 1);
  assert.strictEqual(cache.tally.full, 0);
});
