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
const SIMILAR = 0.02; // "+N" on the dashboard: other dates within 2% of the best price
// Fallbacks per cell, for when the detail pass finds a connection no listed flight makes.
const FALLBACKS = 4;

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
 * True when no flight leaves on the day the previous one lands, counting the long haul as landing
 * day 1 at the earliest (cheap routings often land day 2): connects whatever the times are, nearly.
 */
function isSafe(d0, hops, backDate) {
  let landed = addDays(d0, 1);
  for (const h of hops) {
    if (h.date <= landed) return false;
    landed = h.date;
  }
  return backDate > landed;
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
 * Returns [{ home, cls: 'hybrid'|'economy', in, out, month, total, depart, ret, days, sameDay, safe, tickets, alts, fallbacks }],
 * fallbacks being the next cheapest trips for the same cell plus the cheapest safe one (isSafe).
 * via: '' for the cell's cheapest overall; a city code for its cheapest that stays in that city
 * (in, out or a hop's destination), for the dashboard's via filter. alts is 0 for those.
 * where alts counts the trip's other date sets (depart, ret) in its month within SIMILAR of its
 * price. The array also carries `.dateSets`: "home|cls|in|out" → Map("depart|ret" → cheapest
 * total), for counting across months (similarCount).
 */
function buildTrips(fares) {
  const classes = [['hybrid', 'J'], ['economy', 'Y']];
  const top = new Map(); // key → cheapest FALLBACKS + 1 trips, cheapest first
  const safe = new Map(); // key → cheapest safe trip
  const dateSets = new Map();
  // Kept per cell (via ''), and again per cell and city the trip stays in (the via filter).
  const offer = (trip) => {
    for (const via of ['', ...new Set(trip.tickets.map((t) => t.to).filter((c) => c !== trip.home))]) keep(trip, via);
    const route = `${trip.home}|${trip.cls}|${trip.in}|${trip.out}`;
    if (!dateSets.has(route)) dateSets.set(route, new Map());
    const sets = dateSets.get(route), set = `${trip.depart}|${trip.ret}`;
    if (!(sets.get(set) <= trip.total)) sets.set(set, trip.total);
  };
  const keep = (trip, via) => {
    const key = `${trip.home}|${trip.cls}|${trip.in}|${trip.out}|${trip.month}|${via}`;
    const list = top.get(key) ?? [];
    if (list.length <= FALLBACKS || list.at(-1).total > trip.total) {
      const at = list.findIndex((t) => t.total > trip.total);
      list.splice(at < 0 ? list.length : at, 0, trip);
      if (list.length > FALLBACKS + 1) list.pop();
      top.set(key, list);
    }
    if (trip.safe && !(safe.get(key)?.total <= trip.total)) safe.set(key, trip);
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
              ...base, out: x, total: price + p.cost, ret, days, sameDay: hasSameDay(d0, p.hops, ret), safe: isSafe(d0, p.hops, ret),
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
                ...base, out: y, total: outPrice + p.cost + backPrice, ret, days, sameDay: hasSameDay(d0, p.hops, ret), safe: isSafe(d0, p.hops, ret),
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
  // A trip can head several lists (its cell's and its cities'), so each entry is its own copy.
  const trips = [...top].map(([key, [first, ...rest]]) => {
    const s = safe.get(key);
    const via = key.slice(key.lastIndexOf('|') + 1);
    return { ...first, via, fallbacks: s && !rest.includes(s) && s !== first ? [...rest, s] : rest };
  }).sort((a, b) => a.total - b.total);
  for (const t of trips) t.alts = t.via ? 0 : similarCount(dateSets, t, t.month);
  trips.dateSets = dateSets;
  return trips;
}

/** Other date sets for trip's route and class (in `month`, or any) priced within SIMILAR of it. */
function similarCount(dateSets, trip, month = null) {
  let n = 0;
  for (const [set, total] of dateSets.get(`${trip.home}|${trip.cls}|${trip.in}|${trip.out}`) ?? []) {
    if (set === `${trip.depart}|${trip.ret}` || (month && set.slice(0, 7) !== month)) continue;
    if (total <= trip.total * (1 + SIMILAR)) n++;
  }
  return n;
}

module.exports = { buildTrips, similarCount, hopPlans, hasSameDay, isSafe, addDays };
