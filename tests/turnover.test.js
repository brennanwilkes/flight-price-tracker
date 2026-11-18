const test = require('node:test');
const assert = require('node:assert');
const { turnover } = require('../scraper/src/trips/turnover');

const leg = (code, depDate) => ({ code, depDate });
const rt = (date, ret, out, back, more = {}) => ({ kind: 'rt', from: 'YVR', to: 'HKG', date, ret, cabin: 'J', price: 4000, flights: { out: { legs: [leg(out, date)] }, back: { legs: [leg(back, ret)] } }, ...more });

test('booking queue turnover: what the new and the gone tickets are, how long they stayed, who came back', () => {
  const h = 3600e3;
  const a = rt('2027-09-10', '2027-09-25', 'PR117', 'PR116');
  const b = rt('2027-09-11', '2027-09-25', 'PR117', 'PR116');
  const none = () => false;
  // Build 1: board empty, filters a and b.
  let r = turnover([[], [a, b]], [], null, none, 1000 * h);
  assert.match(r.lines[3], /filters' new \(2 of 2; 2 business, 0 other outbounds\): 2 a route not in the other.*first build counting stays/);
  // Build 2, an hour on: b gone; a's outbound changed; an other outbound of it; another date.
  const a2 = rt('2027-09-10', '2027-09-25', 'CX889', 'PR116');
  const alt = rt('2027-09-10', '2027-09-25', 'AC7', 'PR116', { alt: 1 });
  const c = rt('2027-09-12', '2027-09-26', 'PR117', 'PR116');
  r = turnover([[], [a2, alt, c]], [[], [a, b]], r.seen, (k) => k.includes('PR117@2027-09-11'), 1001 * h);
  assert.match(r.lines[3], /new \(3 of 3; 3 business, 1 other outbounds\): 1 same dates, other outbound flights, 1 another outbound of a ticket in both, 1 other dates on its route; 0 were queued before/);
  assert.match(r.lines[4], /gone \(2 of 2; 2 business, 0 other outbounds\): 1 same dates, other outbound flights, 1 other dates on its route; stayed 2 one build; 1 had a booking page/);
  // Build 3, three hours on: b is back, to the board's tier; c stays.
  r = turnover([[b], [c]], [[], [a2, alt, c]], r.seen, none, 1004 * h);
  assert.match(r.lines[0], /board new \(1 of 1; .*1 were queued before in 48 h \(away 1 4-12 h\)/);
  assert.match(r.lines[5], /by time queued: 1-3 h 1 \(1 not checked in 48 h\)/);
  assert.strictEqual(Object.values(r.seen).filter((v) => v[2] === 2).length, 1);
});

test('booking queue turnover: why each gone ticket left (dearer, not planned, its cell cheaper, a flip)', () => {
  const { keyOf } = require('../scraper/src/trips/bookings');
  const cell = 'YVR|HKG|hybrid band 2027-09-01';
  const flip = rt('2027-09-10', '2027-09-25', 'PR117', 'PR116', { cell, cellTotal: 4000 });
  const dearer = rt('2027-09-11', '2027-09-25', 'PR117', 'PR116', { cell, cellTotal: 4000 });
  const lost = rt('2027-09-12', '2027-09-25', 'PR117', 'PR116', { cell, cellTotal: 4000 });
  const cheaperCell = rt('2027-09-13', '2027-09-25', 'PR117', 'PR116', { cell: 'other', cellTotal: 4000 });
  const disc = rt('2027-09-14', '2027-09-25', 'PR117', 'PR116', { cell, cellTotal: 4000, price: 3500, listed: 4000 });
  const priceNow = new Map([[keyOf(flip), 4000], [keyOf(dearer), 4400], [keyOf(cheaperCell), 4000], [keyOf(disc), 4000]]);
  const cellTotal = new Map([[cell, 4000], ['other', 3600]]);
  const r = turnover([[], []], [[], [flip, dearer, lost, cheaperCell, disc]], null, (k) => k === keyOf(flip), 1000 * 3600e3, undefined, { priceNow, cellTotal });
  const line = r.lines.find((l) => l.includes("filters' gone, why"));
  assert.match(line, /1 same price, its cell the same total with another trip \(a flip\)/);
  assert.match(line, /1 dearer now \(listed up\)/);
  assert.match(line, /1 not planned now, its cell the same total with another trip \(a flip\)/);
  assert.match(line, /1 same price, its cell found a cheaper trip/);
  assert.match(line, /1 dearer now \(was below listed: booking price gone or up\)/);
  assert.match(line, /; 1 of the flips had a booking page/);
});

test('booking queue turnover: a gone cell says its kind and whether its row is still there', () => {
  const gone = [
    rt('2027-09-10', '2027-09-25', 'PR117', 'PR116', { cell: 'YVR|HKG|J band 2027-09-01 fast 14', cellTotal: 4000 }),
    rt('2027-09-11', '2027-09-25', 'PR117', 'PR116', { cell: 'YVR|HKG|J 2027-09', cellTotal: 4000 }),
    rt('2027-09-12', '2027-09-25', 'PR117', 'PR116', { cell: 'YVR|BKK|J', cellTotal: 4000 }),
    rt('2027-09-13', '2027-09-25', 'PR117', 'PR116', { cell: 'YVR|HKG|Y', cellTotal: 4000 }),
  ];
  const r = turnover([[], []], [[], gone], null, () => false, 1000 * 3600e3, undefined, { priceNow: new Map(), cellTotal: new Map([['YVR|HKG|J', 4000]]) });
  const line = r.lines.find((l) => l.includes("filters' gone, why"));
  assert.match(line, /its cell gone \(band long-haul cap, row there\)/);
  assert.match(line, /its cell gone \(month, row there\)/);
  assert.match(line, /its cell gone \(whole row, row gone\)/);
  assert.match(line, /its cell gone \(whole row, row there, not its class\)/);
});
