'use strict';
/* Decoders pinned to real responses captured 2026-10-30. If Google changes the format, these fail. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseBatchExecute, parseCalendar, parseBooking } = require('../scraper/src/gflights/batchexecute');
const { buildTfs } = require('../scraper/src/gflights/tfs');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('tfs: round trip YVR⇄ICN business matches the URL Google accepted', () => {
  assert.strictEqual(
    buildTfs({ from: 'YVR', to: 'ICN', out: '2027-09-15', ret: '2027-09-29', cabin: 'J' }),
    'CBwQAhoeEgoyMDI3LTA5LTE1agcIARIDWVZScgcIARIDSUNOGh4SCjIwMjctMDktMjlqBwgBEgNJQ05yBwgBEgNZVlJAAUgDcAGYAQE',
  );
});

test('price graph: 60 consecutive departure days at a 14-day trip length', () => {
  const cells = parseBatchExecute(fixture('graph-yvr-icn-j-14d-20261201.txt')).flatMap(parseCalendar);
  assert.strictEqual(cells.length, 60);
  assert.deepStrictEqual(cells[0], { out: '2026-11-24', ret: '2026-12-08', price: 4817 });
  assert.ok(cells.every((c) => c.price > 0 && (Date.parse(c.ret) - Date.parse(c.out)) / 864e5 === 14));
});

test('booking: airline-direct vs OTA, fare brands, and cabin match', () => {
  const opts = parseBatchExecute(fixture('booking-yvr-icn-j-20261201.txt')).flatMap(parseBooking);
  assert.strictEqual(opts.length, 9);
  const direct = opts.filter((o) => o.airlineDirect);
  assert.deepStrictEqual(direct.map((o) => [o.seller, o.price, o.fare, o.matchesCabin]), [
    ['KE', 3586, 'Economy Flex', false],
    ['KE', 5396, 'Prestige Standard', true],
    ['KE', 10996, 'Prestige Plus', true],
    ['KE', 14396, 'Prestige Flex', true],
  ]);
  assert.deepStrictEqual(direct[1].cabins, [3, 3]);
  const ota = opts.filter((o) => !o.airlineDirect);
  assert.deepStrictEqual(ota.map((o) => o.price), [5175, 5181, 5337, 5337, 5396]);
});
