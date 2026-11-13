'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { graphTickets, provenPrice } = require('../scraper/src/trips/ties');
const { keyOf } = require('../scraper/src/trips/bookings');

test('graph tickets: business round trips home⇄city, cheapest against its route first, skipping those checked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ties-'));
  const put = (id, o) => { fs.mkdirSync(path.join(dir, 'routes', id), { recursive: true }); fs.writeFileSync(path.join(dir, 'routes', id, 'current.json'), JSON.stringify(o)); };
  const seen = new Date().toISOString();
  put('YVR-HKG-J', { '2027-09-01|15': { ret: '2027-09-16', price: 4870, seen }, '2027-09-10|15': { ret: '2027-09-25', price: 4870, seen }, '2027-09-02|15': { ret: '2027-09-17', price: 6000, seen } });
  put('YVR-SIN-J', { '2027-09-03|15': { ret: '2027-09-18', price: 5100, seen }, '2027-09-04|15': { ret: '2027-09-19', price: 5000, seen, }, '2027-09-05|15': { ret: '2027-09-20', price: 9000, seen: '2026-01-01T00:00:00Z' } });
  put('YVR-HKG-J-OW', { '2027-09-01|0': { price: 2000, seen } });
  put('YVR-HKG-Y', { '2027-09-01|15': { ret: '2027-09-16', price: 1200, seen } });
  const got = graphTickets(dir, ['YVR', 'YYJ'], { skip: new Set(['YVR|HKG|J|2027-09-01|2027-09-16']) });
  assert.deepStrictEqual(got.map((t) => `${t.to} ${t.date} ${t.price}`), ['HKG 2027-09-10 4870', 'SIN 2027-09-04 5000', 'SIN 2027-09-03 5100', 'HKG 2027-09-02 6000']);
  assert.deepStrictEqual([got[0].kind, got[0].ret, got[0].from], ['rt', '2027-09-25', 'YVR']);
});

test('proven price: the cheapest booked over its own and its other outbounds, never a partial page', () => {
  const legs = (c) => ({ legs: [{ code: c, depDate: '2027-09-10' }] });
  const t = { kind: 'rt', from: 'YVR', to: 'HKG', cabin: 'J', date: '2027-09-10', ret: '2027-09-25', price: 4870, flights: { out: legs('PR117'), back: legs('PR116') } };
  const alt = { ...t, flights: { out: legs('CX865'), back: legs('PR116') } };
  const other = { ...t, date: '2027-09-11', flights: { out: legs('CX1'), back: legs('PR116') } };
  const m = new Map();
  assert.strictEqual(provenPrice(t, [t, alt], m, keyOf), null);
  m.set(keyOf(t), { price: 4880 });
  assert.strictEqual(provenPrice(t, [t, alt], m, keyOf), 4880);
  m.set(keyOf(alt), { price: 3450 });
  m.set(keyOf(other), { price: 1000 });
  assert.strictEqual(provenPrice(t, [t, alt, other], m, keyOf), 3450);
  m.set(keyOf(alt), { price: 2000, partial: true });
  assert.strictEqual(provenPrice(t, [t, alt], m, keyOf), 4880);
});
