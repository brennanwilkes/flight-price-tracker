'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applyBookings, stripBookings, bookingCandidates, bookingPass, keyOf } = require('../scraper/src/trips/bookings');
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
  const dear = mapOf([[keyOf(ticket), { price: 5000, seller: 'X', at: '2026-11-11T20:00:00Z' }]]);
  assert.strictEqual(applyBookings(dear, outQ, [{ price: 4870, legs: OUT }])[0].price, 4870);
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
