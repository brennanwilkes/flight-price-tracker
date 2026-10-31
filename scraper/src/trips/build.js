'use strict';
/* Trip builder (SCOPE.md: Trip builder and dashboard).
 *
 * A trip: a long leg home → city X (round trip, or a one-way), any number of economy hops within
 * Asia on separate tickets, a long leg city Y → home. 14-21 days home to home, both long legs in the
 * same cabin, and ≥ 5 nights in Da Nang somewhere along the way. Ranked by total price, nothing else.
 *
 * The hops in between don't depend on the long legs, so for each arrival city X and departure day
 * a forward DP over (day, city, Da Nang done?) finds the cheapest hop sequence to every (Y, day);
 * each long-leg fare then just adds its price on top.
 *
 * Day 0 is the departure from home; the Pacific crossing lands on day 1 (date line). Hops land the
 * day they leave. A flight on the day the previous ticket lands is a same-day connection: allowed
 * (≥ 4 h, SCOPE) but the price graph has no times, so the trip is marked `sameDay` to verify.
 */

const MIN_DAYS = 14;
const MAX_DAYS = 21;
const DAD = 'DAD';
const DAD_NIGHTS = 5;

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * Cheapest hop plans from arrival city `x`, landing day 1 after departure `d0`.
 * Returns plan(y, t): the cheapest way to be in city y on day t, ready to fly home, having done
 * Da Nang; { cost, hops: [{ from, to, date, price }] } or null.
 */
function hopPlans(x, d0, cities, hopPrice) {
  // best[t] maps "city|done" → { cost, prev: key at t (or at an earlier day for the Da Nang jump), t, hop }
  const best = Array.from({ length: MAX_DAYS + 1 }, () => new Map());
  const put = (t, city, done, cost, prev, hop) => {
    if (t > MAX_DAYS) return false;
    const key = `${city}|${done}`;
    const cur = best[t].get(key);
    if (cur && cur.cost <= cost) return false;
    best[t].set(key, { city, done, cost, prev, hop });
    return true;
  };
  // Landing in Da Nang (not yet done) also offers "stay the 5 nights": done, 5 days later.
  const land = (t, city, cost, prev, hop) => {
    const changed = put(t, city, 0, cost, prev, hop);
    if (city === DAD) put(t + DAD_NIGHTS, DAD, 1, cost, { t, key: `${DAD}|0` }, null);
    return changed;
  };
  land(1, x, 0, null, null);

  for (let t = 1; t <= MAX_DAYS; t++) {
    if (t > 1) for (const [key, s] of best[t - 1]) put(t, s.city, s.done, s.cost, { t: t - 1, key }, null); // stay a night
    const date = addDays(d0, t);
    // Hops on this day, chained same-day as long as it gets cheaper (prices > 0, so this ends).
    for (let changed = true; changed;) {
      changed = false;
      for (const [key, s] of [...best[t]]) {
        if (best[t].get(key) !== s) continue;
        for (const to of cities) {
          if (to === s.city) continue;
          const price = hopPrice(s.city, to, date);
          if (price == null) continue;
          const hop = { from: s.city, to, date, price };
          const prev = { t, key };
          if (s.done ? put(t, to, 1, s.cost + price, prev, hop) : land(t, to, s.cost + price, prev, hop)) changed = true;
        }
      }
    }
  }

  return (y, t) => {
    const end = best[t]?.get(`${y}|1`);
    if (!end) return null;
    const hops = [];
    for (let s = end; s.prev; s = best[s.prev.t].get(s.prev.key)) if (s.hop) hops.push(s.hop);
    return { cost: end.cost, hops: hops.reverse() };
  };
}

/** True when any flight leaves on the day the previous ticket lands (times to verify). */
function hasSameDay(d0, hops, backDate) {
  let landed = addDays(d0, 1);
  for (const h of hops) {
    if (h.date === landed) return true;
    landed = h.date;
  }
  return backDate === landed;
}

/**
 * Every trip worth showing, as the cheapest per (home, class, in-city, out-city, departure month).
 *
 * fares: {
 *   homes, cities,                                  // e.g. ['YVR','YYJ'], ['DAD','ICN',…]
 *   roundTrip(home, city, cabin, out)  → [{ ret, price }]   (any trip lengths Google priced)
 *   oneWay(from, to, cabin, date)      → price | null      (long legs, either direction)
 *   hop(from, to, date)                → price | null      (economy within Asia)
 *   departures                         → sorted ISO dates to try as day 0
 * }
 * Returns [{ home, cls: 'hybrid'|'economy', in, out, month, total, depart, ret, days, sameDay, tickets }].
 */
function buildTrips(fares) {
  const classes = [['hybrid', 'J'], ['economy', 'Y']];
  const best = new Map();
  const offer = (trip) => {
    const key = `${trip.home}|${trip.cls}|${trip.in}|${trip.out}|${trip.month}`;
    if (!best.has(key) || best.get(key).total > trip.total) best.set(key, trip);
  };

  for (const d0 of fares.departures) {
    for (const x of fares.cities) {
      const plan = hopPlans(x, d0, fares.cities, fares.hop);
      for (const home of fares.homes) {
        for (const [cls, cabin] of classes) {
          const base = { home, cls, in: x, month: d0.slice(0, 7), depart: d0 };
          // Round trip: home on the same ticket, so in = out.
          for (const { ret, price } of fares.roundTrip(home, x, cabin, d0)) {
            const days = (Date.parse(ret) - Date.parse(d0)) / 864e5;
            const p = days >= MIN_DAYS && days <= MAX_DAYS && plan(x, days);
            if (!p) continue;
            offer({
              ...base, out: x, total: price + p.cost, ret, days, sameDay: hasSameDay(d0, p.hops, ret),
              tickets: [{ kind: 'rt', from: home, to: x, date: d0, ret, cabin, price }, ...p.hops.map((h) => ({ kind: 'ow', ...h, cabin: 'Y' }))],
            });
          }
          // Two one-ways: in and out may differ.
          const outPrice = fares.oneWay(home, x, cabin, d0);
          if (outPrice == null) continue;
          for (let days = MIN_DAYS; days <= MAX_DAYS; days++) {
            const ret = addDays(d0, days);
            for (const y of fares.cities) {
              const backPrice = fares.oneWay(y, home, cabin, ret);
              if (backPrice == null) continue;
              const p = plan(y, days);
              if (!p) continue;
              offer({
                ...base, out: y, total: outPrice + p.cost + backPrice, ret, days, sameDay: hasSameDay(d0, p.hops, ret),
                tickets: [
                  { kind: 'ow', from: home, to: x, date: d0, cabin, price: outPrice },
                  ...p.hops.map((h) => ({ kind: 'ow', ...h, cabin: 'Y' })),
                  { kind: 'ow', from: y, to: home, date: ret, cabin, price: backPrice },
                ],
              });
            }
          }
        }
      }
    }
  }
  return [...best.values()].sort((a, b) => a.total - b.total);
}

module.exports = { buildTrips, hopPlans, hasSameDay, addDays };
