'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadFares, fareKey, fareOf } = require('../scraper/src/trips/fares');
const config = require('../scraper/config/sweep.json');

test('listed prices from flight checks replace the graph prices they were checked against', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fares-'));
  const seen = new Date().toISOString();
  const put = (id, cells) => {
    fs.mkdirSync(path.join(dir, 'routes', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'routes', id, 'current.json'), JSON.stringify(cells));
  };
  put('BKK-HAN-Y-OW', { '2027-09-03|0': { ret: null, price: 138, seen }, '2027-09-10|0': { ret: null, price: 138, seen } });
  put('YVR-BKK-J', { '2027-09-01|14': { ret: '2027-09-15', price: 5000, seen } });
  const hop = { kind: 'ow', from: 'BKK', to: 'HAN', cabin: 'Y', date: '2027-09-03' };
  const rt = { kind: 'rt', from: 'YVR', to: 'BKK', cabin: 'J', date: '2027-09-01', ret: '2027-09-15' };
  const checked = new Map([[fareKey(hop), 232], [fareKey(rt), 4800], ['BKK|HAN|Y|2027-09-20', 90]]);
  const fares = loadFares(dir, config, { checked });
  assert.strictEqual(fares.hop('BKK', 'HAN', '2027-09-03'), 232);
  assert.strictEqual(fares.hop('BKK', 'HAN', '2027-09-10'), 138);
  assert.strictEqual(fares.hop('BKK', 'HAN', '2027-09-20'), null); // no graph price: not a fare to add
  assert.deepStrictEqual(fares.roundTrip('YVR', 'BKK', 'J', '2027-09-01'), [{ ret: '2027-09-15', price: 4800 }]);
  assert.strictEqual(fareOf(fares, fareKey(rt)), 4800);
  fs.rmSync(dir, { recursive: true });
});
