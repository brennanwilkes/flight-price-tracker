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
