'use strict';
/* How flexible a trip's stays are: "10 nights (4–12)" on the dashboard.
 *
 * Each economy one-way inside Asia is moved earlier or later on its own, the long legs and any
 * return tickets fixed, keeping every flight in order (same-day connections allowed) and the Hoi An
 * stay ≥ its need (build.js). A move costing at most TOLERANCE of the trip's total widens the range
 * of the stays on both sides of that flight. trip.flex: [[stay, fewer, more]], stay k being the one
 * between order[k] and order[k + 1]: nights can be `fewer` less or `more` more.
 */
const TOLERANCE = 0.03;
const MAX_SHIFT = 14;

const dayNo = (iso) => Date.parse(`${iso}T00:00:00Z`) / 864e5;
const isoOf = (n) => new Date(n * 864e5).toISOString().slice(0, 10);

function flexOf(trip, fares) {
  if (!trip?.order) return [];
  const homes = new Set(fares.homes);
  const fl = trip.order.map(([i, dir]) => {
    const t = trip.tickets[i];
    const long = homes.has(t.from) || homes.has(t.to);
    const date = dayNo(dir === 'back' ? t.ret : t.date);
    return { t, date, land: date + (long ? 1 : 0), movable: t.kind === 'ow' && !long };
  });
  const span = fl.slice(0, -1).map(() => [0, 0]); // per stay: [fewer, more]
  const widen = (k, d) => { if (span[k]) { span[k][0] = Math.max(span[k][0], -d); span[k][1] = Math.max(span[k][1], d); } };
  const budget = trip.total * TOLERANCE;
  for (let k = 1; k < fl.length - 1; k++) {
    const f = fl[k];
    if (!f.movable) continue;
    const was = fares.hop(f.t.from, f.t.to, isoOf(f.date)) ?? f.t.graph ?? f.t.price;
    for (let d = -MAX_SHIFT; d <= MAX_SHIFT; d++) {
      const day = f.date + d;
      if (!d || day < fl[k - 1].land || day > fl[k + 1].date) continue;
      if (trip.stay?.after === k - 1 && day - fl[k - 1].land < trip.stay.need) continue; // leaves Hoi An too soon
      if (trip.stay?.after === k && fl[k + 1].date - day < trip.stay.need) continue; // arrives too late for it
      const price = fares.hop(f.t.from, f.t.to, isoOf(day));
      if (price == null || price - was > budget) continue;
      widen(k - 1, d); // the stay before this flight gets d nights more
      widen(k, -d); // the one after, d fewer
    }
  }
  return span.map(([fewer, more], k) => [k, fewer, more]).filter(([, fewer, more]) => fewer || more);
}

module.exports = { flexOf, TOLERANCE };
