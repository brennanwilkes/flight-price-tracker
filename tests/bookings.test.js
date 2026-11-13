'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadBookings, saveBookings, applyBookings, stripBookings, bookingCandidates, bookingPass, passLine, listedOf, keyOf } = require('../scraper/src/trips/bookings');
const { bookingUrl, inCabin } = require('../scraper/src/gflights/booking');

const leg = (code, from, to, depDate) => ({ code, from, to, depDate });
const OUT = [leg('PR117', 'YVR', 'MNL', '2027-09-10'), leg('PR318', 'MNL', 'HKG', '2027-09-12')];
const BACK = [leg('PR311', 'HKG', 'MNL', '2027-09-25'), leg('PR116', 'MNL', 'YVR', '2027-09-26')];
const ticket = { kind: 'rt', from: 'YVR', to: 'HKG', date: '2027-09-10', ret: '2027-09-25', cabin: 'J', price: 4870, flights: { out: { legs: OUT }, back: { legs: BACK } } };

function mapOf(entries) {
  const m = new Map(entries);
  m.byOut = new Map();
  for (const [k, b] of m) { const [c, o, r] = k.split('|'); if (r) m.byOut.set(`${c}|${o}`, b); }
  return m;
}

test('booking link: the same bytes as Google\'s own for those flights', () => {
  assert.strictEqual(bookingUrl(ticket), 'https://www.google.com/travel/flights/booking?tfs=CBwQAhpgEgoyMDI3LTA5LTEwIh8KA1lWUhIKMjAyNy0wOS0xMBoDTU5MKgJQUjIDMTE3Ih8KA01OTBIKMjAyNy0wOS0xMhoDSEtHKgJQUjIDMzE4agcIARIDWVZScgcIARIDSEtHGmASCjIwMjctMDktMjUiHwoDSEtHEgoyMDI3LTA5LTI1GgNNTkwqAlBSMgMzMTEiHwoDTU5MEgoyMDI3LTA5LTI2GgNZVlIqAlBSMgMxMTZqBwgBEgNIS0dyBwgBEgNZVlJAAUgDcAGCAQsI____________AZgBAQ&hl=en&gl=CA&curr=CAD');
});

test('a booked price lowers the search rows with those flights: outbound list, returns with it chosen, one-way', () => {
  const m = mapOf([[keyOf(ticket), { price: 2785, seller: 'Trip.com', at: '2026-11-11T20:00:00Z' }], ['Y|VN595@2027-09-13|', { price: 390, seller: 'Kiwi.com', at: '2026-11-11T20:00:00Z' }]]);
  const outQ = JSON.stringify({ from: 'YVR', to: 'HKG', out: '2027-09-10', cabin: 'J', ret: '2027-09-25' });
  const outs = applyBookings(m, outQ, [{ price: 4870, legs: OUT }, { price: 4770, legs: [leg('PR117', 'YVR', 'MNL', '2027-09-10'), leg('PR318', 'MNL', 'HKG', '2027-09-13')] }]);
  assert.deepStrictEqual(outs.map((o) => o.price), [2785, 4770]);
  assert.strictEqual(outs[0].seller, 'Trip.com');
  const retQ = JSON.stringify({ from: 'YVR', to: 'HKG', out: '2027-09-10', ret: '2027-09-25', cabin: 'J', selected: OUT.map((l) => ({ from: l.from, to: l.to, date: l.depDate, airline: l.code.slice(0, 2), number: l.code.slice(2) })) });
  assert.strictEqual(applyBookings(m, `full ${retQ}`, [{ price: 4870, legs: BACK }])[0].price, 2785);
  const owQ = JSON.stringify({ from: 'HKG', to: 'SGN', out: '2027-09-13', cabin: 'Y' });
  assert.strictEqual(applyBookings(m, owQ, [{ price: 413, legs: [leg('VN595', 'HKG', 'SGN', '2027-09-13')] }])[0].price, 390);
  // Saved as searched; a dearer booking leaves the row alone.
  assert.deepStrictEqual(stripBookings(outs).map((o) => [o.price, o.seller]), [[4870, undefined], [4770, undefined]]);
  const dear = mapOf([[keyOf(ticket), { price: 6000, seller: 'X', at: '2026-11-11T20:00:00Z' }], ['Y|VN595@2027-09-13|', { price: 900, seller: 'VN', at: '2026-11-11T20:00:00Z' }]]);
  assert.strictEqual(applyBookings(dear, outQ, [{ price: 4870, legs: OUT }])[0].price, 4870);
  // On the exact flights a dearer price in the cabin stands (the listed one was another cabin's).
  assert.strictEqual(applyBookings(dear, `full ${retQ}`, [{ price: 4870, legs: BACK }])[0].price, 6000);
  assert.strictEqual(applyBookings(dear, owQ, [{ price: 413, legs: [leg('VN595', 'HKG', 'SGN', '2027-09-13')] }])[0].price, 900);
  // A page without the listed offer: never applied.
  const part = mapOf([['Y|VN595@2027-09-13|', { price: 300, seller: 'X', at: '2026-11-11T20:00:00Z', partial: true }]]);
  assert.strictEqual(applyBookings(part, owQ, [{ price: 413, legs: [leg('VN595', 'HKG', 'SGN', '2027-09-13')] }])[0].price, 413);
});

test('booking candidates: long-haul tickets first, then their cheapest other outbounds with the same return', () => {
  const hop = { kind: 'ow', from: 'HKG', to: 'SGN', date: '2027-09-13', cabin: 'Y', price: 413, flights: { out: { legs: [leg('VN595', 'HKG', 'SGN', '2027-09-13')] } } };
  const other = [leg('PR117', 'YVR', 'MNL', '2027-09-10'), leg('PR300', 'MNL', 'HKG', '2027-09-12')];
  const q = JSON.stringify({ from: 'YVR', to: 'HKG', out: '2027-09-10', cabin: 'J', ret: '2027-09-25' });
  const rows = new Map([[q, [{ price: 4870, legs: OUT }, { price: 4870, legs: other }, { price: 9000, legs: [leg('CX867', 'YVR', 'HKG', '2027-09-10')] }]]]);
  const got = bookingCandidates([hop, ticket], (k) => rows.get(k) ?? null, new Map(), ['YVR', 'YYJ']);
  assert.deepStrictEqual(got.map((t) => t.flights.out.legs.map((l) => l.code).join('+')), ['PR117+PR318', 'PR117+PR300', 'VN595']);
  assert.strictEqual(got[1].flights.back.legs[0].code, 'PR311');
});

test('booking candidates: the board\'s tickets, hops too, before any filter\'s', () => {
  const hop = { kind: 'ow', from: 'HKG', to: 'SGN', date: '2027-09-13', cabin: 'Y', price: 413, flights: { out: { legs: [leg('VN595', 'HKG', 'SGN', '2027-09-13')] } } };
  const band = { ...ticket, price: 3000, flights: { out: { legs: [leg('CX865', 'YVR', 'HKG', '2027-09-10')] }, back: { legs: [leg('CX888', 'HKG', 'YVR', '2027-09-25')] } } };
  const got = bookingCandidates([[ticket, hop], [band, hop, ticket]], () => null, new Map(), ['YVR', 'YYJ']);
  assert.deepStrictEqual(got.map((t) => t.flights.out.legs[0].code), ['PR117', 'VN595', 'CX865']);
});

test('in cabin: every flight of 6 h or more in the ticket\'s cabin or better; without lengths, every leg', () => {
  assert.ok(inCabin({ cabins: [3, 3, 3, 3] }, 'J'));
  assert.ok(!inCabin({ cabins: [3, 1, 3, 3] }, 'J'));
  assert.ok(inCabin({ cabins: [2] }, 'Y'));
  // No cabins given: not proven in any.
  assert.ok(!inCabin({ cabins: null }, 'Y'));
  assert.ok(!inCabin({}, 'J'));
  // YYJ-YVR (32 min) in economy, the crossing in business: business. Premium economy on the crossing: not.
  const legs = [{ min: 32 }, { min: 760 }, { min: 270 }];
  assert.ok(inCabin({ cabins: [1, 3, 1] }, 'J', legs));
  assert.ok(!inCabin({ cabins: [1, 2, 1] }, 'J', legs));
  assert.ok(!inCabin({ cabins: [1, 3] }, 'J', legs));
});

test('a page with no seller in its cabin is kept (not asked again), never lowers a row', async () => {
  const m = mapOf([]);
  const withMin = (legs) => legs.map((l, i) => ({ ...l, min: i % 2 ? 120 : 760 }));
  const timed = { ...ticket, flights: { out: { legs: withMin(OUT) }, back: { legs: withMin(BACK) } } };
  // Without lengths: not kept.
  await bookingPass([ticket], async () => [{ sellerName: 'Air Canada', price: 2000, cabins: [1, 2, 1, 1] }], m, { until: Date.now() + 60e3, pages: 1, inCabin });
  assert.strictEqual(m.size, 0);
  const s = await bookingPass([timed], async () => [{ sellerName: 'Air Canada', price: 2000, cabins: [1, 2, 1, 1] }], m, { until: Date.now() + 60e3, pages: 1, inCabin });
  assert.deepStrictEqual([s.checked, s.none, m.get(keyOf(ticket)).price], [1, 1, null]);
  assert.deepStrictEqual(bookingCandidates([timed], () => null, m, ['YVR']), []);
  const outQ = JSON.stringify({ from: 'YVR', to: 'HKG', out: '2027-09-10', cabin: 'J', ret: '2027-09-25' });
  assert.strictEqual(applyBookings(m, outQ, [{ price: 4870, legs: OUT }])[0].price, 4870);
});

test('a page without the listed offer in any cabin: held as partial, a dearer one in the cabin counted as mixed', async () => {
  const m = mapOf([]);
  const hop = (code, price) => ({ kind: 'ow', from: 'HKG', to: 'SGN', date: '2027-09-13', cabin: 'Y', price, flights: { out: { legs: [{ ...leg(code, 'HKG', 'SGN', '2027-09-13'), min: 160 }] } } });
  const pages = { VN1: [{ sellerName: 'VN', price: 600, cabins: [1] }], VN2: [{ sellerName: 'X', price: 400, cabins: [] }, { sellerName: 'VN', price: 700, cabins: [1] }] };
  const s = await bookingPass([hop('VN1', 400), hop('VN2', 410)], async (t) => pages[t.flights.out.legs[0].code], m, { until: Date.now() + 60e3, pages: 1, inCabin });
  assert.deepStrictEqual([s.partial, s.mixed, s.noCabins], [1, 1, 1]);
  assert.strictEqual(m.get('Y|VN1@2027-09-13|').partial, true);
  assert.deepStrictEqual([m.get('Y|VN2@2027-09-13|').price, m.get('Y|VN2@2027-09-13|').n, m.get('Y|VN2@2027-09-13|').any], [700, 2, 400]);
});

test('a page is held to the listed price, not an earlier booking price', async () => {
  // Board ticket priced $2,785 by an earlier booking; Google listed $4,870. Now $4,612 is the cheapest: a full page.
  const booked = { ...ticket, price: 2785, flights: { out: { legs: OUT.map((l) => ({ ...l, min: 300 })) }, back: { legs: BACK.map((l) => ({ ...l, min: 300 })), listedPrice: 4870 } } };
  assert.strictEqual(listedOf(booked), 4870);
  const m = mapOf([]);
  const s = await bookingPass([booked], async () => [{ sellerName: 'FlightHub', price: 4612, cabins: [3, 3, 3, 3] }], m, { until: Date.now() + 60e3, pages: 1, inCabin });
  assert.deepStrictEqual([s.partial, s.cheaper, m.get(keyOf(booked)).price], [0, 1, 4612]);
  // The queue's `listed` and an other outbound's own row price come first.
  assert.strictEqual(listedOf({ ...booked, listed: 5000 }), 5000);
});

test('a recheck is compared with the expired price kept 48 h (map.prev), which is saved again', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), 'b.json');
  const timed = { ...ticket, flights: { out: { legs: OUT.map((l) => ({ ...l, min: 300 })) }, back: { legs: BACK.map((l) => ({ ...l, min: 300 })) } } };
  const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  fs.writeFileSync(f, JSON.stringify({ [keyOf(timed)]: { price: 4500, seller: 'X', at: ago(20), listed: 4870, n: 9 }, 'Y|OLD@2027-01-01|': { price: 1, at: ago(60), listed: 1, n: 9 } }));
  const m = loadBookings([f]);
  assert.deepStrictEqual([m.size, m.prev.size], [0, 1]);
  const s = await bookingPass([timed], async () => [{ sellerName: 'Trip.com', price: 3450, cabins: [3, 3, 3, 3] }], m, { until: Date.now() + 60e3, pages: 1, inCabin });
  assert.deepStrictEqual(s.again, { 'listed same, booked lower': 1 });
  assert.match(passLine(s), /biggest drop with the listed price unmoved .*\$4500 → \$3450/);
  saveBookings(f, m);
  const back = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(Object.keys(back), [keyOf(timed)]);
  assert.strictEqual(back[keyOf(timed)].price, 3450);
});
