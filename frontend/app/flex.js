/* How flexible a trip's stays are: "10 nights (4–12)" on the dashboard.
 *
 * Each flight that can move on its own is moved earlier or later: economy one-ways inside Asia, and
 * the first and last long flights (to and from home: a Pacific stop's flight on to Asia stays put) (the trip kept 14–21 days; a one-way or return priced from the
 * graph's other days for that flight). A multi-city ticket's flights stay put: the graph has no
 * price for that ticket on other days, and a range is only claimed from real prices. Every flight stays in order (same-day connections
 * allowed) and the Hoi An stay ≥ its need (build.js). A move costing about the same (price.js: a
 * share of the trip's total) widens the range of the stays on both sides of that flight.
 * trip.flex: [[stay, fewer, more]], stay k being the one between order[k] and order[k + 1]: nights
 * can be `fewer` less or `more` more.
 */
import { samePrice } from './price.js';
import { isLong, landsAfter } from './cities.js';

const MAX_SHIFT = 14;
const MIN_DAYS = 14;
const MAX_DAYS = 21;

const dayNo = (iso) => Date.parse(`${iso}T00:00:00Z`) / 864e5;
const isoOf = (n) => new Date(n * 864e5).toISOString().slice(0, 10);

/** The flight at an order entry: { from, to, date } (multi.js: 'leg<k>'; a return's 'back'). */
function flightAt(t, dir) {
  if (dir === 'back') return { from: t.to, to: t.from, date: t.ret };
  if (dir.startsWith('leg')) return t.legs[Number(dir.slice(3))];
  return { from: t.from, to: t.to, date: t.date };
}

function flexOf(trip, fares) {
  if (!trip?.order) return [];
  const fl = trip.order.map(([i, dir]) => {
    const t = trip.tickets[i];
    const f = flightAt(t, dir);
    const date = dayNo(f.date);
    return { t, dir, ...f, date, land: date + landsAfter(f.from, f.to, fares.homes), long: isLong(f.from, f.to, fares.homes) };
  });
  const last = fl.length - 1;
  // A flight's graph price on another day, or null: what moving it alone would cost.
  const priceOn = (f, day) => {
    const iso = isoOf(day);
    if (!f.long) return f.t.kind === 'ow' ? fares.hop(f.from, f.to, iso) : null;
    if (f.t.kind === 'rt') {
      const out = f.dir === 'back' ? f.t.date : iso, ret = f.dir === 'back' ? iso : f.t.ret;
      return fares.roundTrip(f.t.from, f.t.to, f.t.cabin, out).find((r) => r.ret === ret)?.price ?? null;
    }
    return f.t.kind === 'ow' ? fares.oneWay(f.from, f.to, f.t.cabin, iso) : null;
  };
  const span = fl.slice(0, -1).map(() => [0, 0]); // per stay: [fewer, more]
  const widen = (k, d) => { if (span[k]) { span[k][0] = Math.max(span[k][0], -d); span[k][1] = Math.max(span[k][1], d); } };
  const budget = trip.total * samePrice(trip);
  for (let k = 0; k <= last; k++) {
    const f = fl[k];
    if (f.long ? k !== 0 && k !== last : f.t.kind !== 'ow') continue;
    const was = priceOn(f, f.date) ?? (f.long ? null : f.t.graph ?? f.t.price);
    if (was == null) continue;
    for (let d = -MAX_SHIFT; d <= MAX_SHIFT; d++) {
      const day = f.date + d;
      if (!d || (k > 0 && day < fl[k - 1].land) || (k < last && day + (f.land - f.date) > fl[k + 1].date)) continue;
      if (f.long) { // the trip's length, home to home
        const days = k === 0 ? fl[last].date - day : day - fl[0].date;
        if (days < MIN_DAYS || days > MAX_DAYS) continue;
      }
      if (trip.stay?.after === k - 1 && day - fl[k - 1].land < trip.stay.need) continue; // leaves Hoi An too soon
      if (trip.stay?.after === k && fl[k + 1].date - (day + f.land - f.date) < trip.stay.need) continue; // arrives too late for it
      const price = priceOn(f, day);
      if (price == null || price - was > budget) continue;
      widen(k - 1, d); // the stay before this flight gets d nights more
      widen(k, -d); // the one after, d fewer
    }
  }
  return span.map(([fewer, more], k) => [k, fewer, more]).filter(([, fewer, more]) => fewer || more);
}

export { flexOf };
