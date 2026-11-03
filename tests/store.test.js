'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordCells } = require('../scraper/src/store/routes');

test('recordCells: rows only on change (incl. to/from empty); first-priced time kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const at = (h) => `2026-10-31T0${h}:00:00Z`;
  const opts = (h) => ({ observedAt: at(h), egress: 'vpn' });
  const cell = (out, price) => ({ out, ret: '2027-09-15', price });

  assert.strictEqual(recordCells(dir, 'YVR-ICN-J', 14, [cell('2027-09-01', null), cell('2027-09-02', 4817)], opts(1)), 2);
  assert.strictEqual(recordCells(dir, 'YVR-ICN-J', 14, [cell('2027-09-01', null), cell('2027-09-02', 4817)], opts(2)), 0);
  assert.strictEqual(recordCells(dir, 'YVR-ICN-J', 14, [cell('2027-09-01', 3999), cell('2027-09-02', null)], opts(3)), 2);
  // Another trip length is a separate cell.
  assert.strictEqual(recordCells(dir, 'YVR-ICN-J', 17, [cell('2027-09-02', 4817)], opts(3)), 1);

  const csv = fs.readFileSync(path.join(dir, 'routes/YVR-ICN-J/2026-10.csv'), 'utf8').trim().split('\n');
  assert.deepStrictEqual(csv.slice(1), [
    `${at(1)},2027-09-01,2027-09-15,14,,vpn`,
    `${at(1)},2027-09-02,2027-09-15,14,4817,vpn`,
    `${at(3)},2027-09-01,2027-09-15,14,3999,vpn`,
    `${at(3)},2027-09-02,2027-09-15,14,,vpn`,
    `${at(3)},2027-09-02,2027-09-15,17,4817,vpn`,
  ]);
  const cur = JSON.parse(fs.readFileSync(path.join(dir, 'routes/YVR-ICN-J/current.json'), 'utf8'));
  assert.deepStrictEqual(cur['2027-09-01|14'], { ret: '2027-09-15', price: 3999, seen: at(3), first: at(3), changed: at(3) });
  assert.deepStrictEqual(cur['2027-09-02|14'], { ret: '2027-09-15', price: null, seen: at(3), first: at(1), changed: at(3) });

  // A cell from before `changed` existed takes its last CSV row's time; an unchanged price keeps it.
  const curFile = path.join(dir, 'routes/YVR-ICN-J/current.json');
  delete cur['2027-09-01|14'].changed;
  fs.writeFileSync(curFile, JSON.stringify(cur));
  recordCells(dir, 'YVR-ICN-J', 14, [cell('2027-09-01', 3999)], opts(5));
  assert.strictEqual(JSON.parse(fs.readFileSync(curFile, 'utf8'))['2027-09-01|14'].changed, at(3));
});

test('packJson/unpack: a ticket shared by several trips is stored once and comes back in place', async () => {
  const { packJson, unpack } = await import('../frontend/app/pack.js');
  const tk = { kind: 'rt', from: 'YVR', to: 'HAN', price: 4309, flights: { out: { legs: [{ code: 'PR117' }] } } };
  const hop = { kind: 'ow', from: 'HAN', to: 'DAD', price: 49 };
  const data = { home: 'YVR', rows: [{ hybrid: { total: 4358, tickets: [tk, hop] }, months: { '2027-09': { hybrid: { total: 4358, tickets: [tk, hop] } } } }] };
  const text = packJson(data);
  assert.strictEqual(text.split('PR117').length, 2);
  assert.deepStrictEqual(unpack(JSON.parse(text)), data);
  assert.deepStrictEqual(unpack({ rows: [] }), { rows: [] }, 'older files pass through');
});
