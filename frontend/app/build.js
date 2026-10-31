/* Trip builder (SCOPE.md: Trip builder and dashboard; Decisions 2026-10-31, coverage).
 *
 * A trip: a long leg home → city X (round trip, or a one-way), any tickets within Asia (economy
 * one-ways, and returns nested inside the trip), a long leg city Y → home. 14-21 days home to home,
 * both long legs in the same cabin, and ≥ 5 nights in Hoi An somewhere along the way, reached
 * overland from a Vietnam anchor city (Da Nang, Hue, Hanoi, Saigon; ground days each way from
 * fares.anchors): in at one anchor, out at any. Ranked by total price, nothing else.
 *
 * The flights in Asia don't depend on the long legs, so for each arrival city X and departure day a
 * forward DP over (day, city, Hoi An done?, open return?) finds the cheapest plan to every (Y, day);
 * each long-leg fare then just adds its price on top. An Asia return A⇄B opens an obligation: be in
 * B on its return day and fly B → A (already paid). One open at a time, closed before flying home.
 *
 * Day 0 is the departure from home; the Pacific crossing lands on day 1 (date line). Hops land the
 * day they leave. A flight on the day the previous ticket lands is a same-day connection: allowed
 * (≥ 4 h, SCOPE) but the price graph has no times, so the trip is marked `sameDay` to verify.
 */

const MIN_DAYS = 14;
const MAX_DAYS = 21;
const HOI_AN_NIGHTS = 5;
const SIMILAR = 0.02; // "+N" on the dashboard: other dates within 2% of the best price
// Fallbacks per cell, for when the detail pass finds a connection no listed flight makes.
const FALLBACKS = 4;

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * Cheapest plans within Asia from arrival city `x`, landing day 1 after departure `d0`.
 * Returns plan(y, t): the cheapest way to be in city y on day t, ready to fly home, Hoi An done,
 * no return open and a night in each of `need` (the via filter's cities; staysOf's sense: a night
 * there, or either end of the Hoi An stay); { cost, hops: [{ kind: 'ow'|'rt'|'back'|'stay', from,
 * to, date, ret?, price }] } or null ('back' is a nested return's second flight, paid with its 'rt';
 * 'stay' marks the Hoi An stay).
 */
function hopPlans(x, d0, fares, need = []) {
  const { cities, hop, anchors = { DAD: 0 } } = fares;
  const asiaRT = fares.asiaRT ?? (() => []);
  const bit = (c) => (need.includes(c) ? 1 << need.indexOf(c) : 0);
  const all = (1 << need.length) - 1;
  // best[t] maps "city|done|open|seen" → { city, done, open, seen, cost, prev: { t, key }, hop }
  // open: '' or "B>A@day" (fly B → A on that day, already paid); seen: bits of `need` stayed in.
  const best = Array.from({ length: MAX_DAYS + 1 }, () => new Map());
  const dueOf = (open) => (open ? Number(open.slice(open.indexOf('@') + 1)) : Infinity);
  const keyOf = (city, done, open, seen) => `${city}|${done}|${open}|${seen}`;
  const put = (t, city, done, open, seen, cost, prev, hop) => {
    if (t > MAX_DAYS || t > dueOf(open)) return false;
    // Not if a state that has seen as much or more is as cheap.
    for (let m = seen; m <= all; m = (m + 1) | seen) if (best[t].get(keyOf(city, done, open, m))?.cost <= cost) return false;
    best[t].set(keyOf(city, done, open, seen), { city, done, open, seen, cost, prev, hop });
    return true;
  };
  // Landing at a Vietnam anchor also offers the Hoi An stay: overland there, the nights, overland
  // to any anchor (open jaw); done on the day that leaves.
  const land = (t, city, done, open, seen, cost, prev, hop) => {
    const changed = put(t, city, done, open, seen, cost, prev, hop);
    if (!done && city in anchors && best[t].get(keyOf(city, done, open, seen))?.cost === cost) {
      for (const [w, g] of Object.entries(anchors)) {
        const days = anchors[city] + HOI_AN_NIGHTS + g; // from landing at `city` to flying out of `w`
        put(t + days, w, 1, open, seen | bit(city) | bit(w), cost, { t, key: keyOf(city, 0, open, seen) }, { kind: 'stay', from: city, to: w, need: days });
      }
    }
    return changed;
  };
  land(1, x, 0, '', 0, 0, null, null);

  for (let t = 1; t <= MAX_DAYS; t++) {
    if (t > 1) { // stay a night
      for (const [key, s] of best[t - 1]) put(t, s.city, s.done, s.open, s.seen | bit(s.city), s.cost, { t: t - 1, key }, null);
    }
    const date = addDays(d0, t);
    // Flights on this day, chained same-day as long as it gets cheaper (prices > 0 but a nested
    // return's second flight, which only closes an open return, so this ends).
    for (let changed = true; changed;) {
      changed = false;
      for (const [key, s] of [...best[t]]) {
        if (best[t].get(key) !== s) continue;
        const prev = { t, key };
        if (s.open) {
          const [b, rest] = s.open.split('>');
          const a = rest.slice(0, rest.indexOf('@'));
          if (s.city === b && dueOf(s.open) === t) {
            if (land(t, a, s.done, '', s.seen, s.cost, prev, { kind: 'back', from: b, to: a, date, price: 0 })) changed = true;
          }
          if (dueOf(s.open) === t) continue; // the return day: only the return flight
        }
        for (const to of cities) {
          if (to === s.city) continue;
          const price = hop(s.city, to, date);
          if (price != null && land(t, to, s.done, s.open, s.seen, s.cost + price, prev, { kind: 'ow', from: s.city, to, date, price })) changed = true;
          if (s.open) continue;
          for (const r of asiaRT(s.city, to, date)) {
            const due = t + (Date.parse(r.ret) - Date.parse(date)) / 864e5;
            if (due > MAX_DAYS) continue;
            const hopRt = { kind: 'rt', from: s.city, to, date, ret: r.ret, price: r.price };
            if (land(t, to, s.done, `${to}>${s.city}@${due}`, s.seen, s.cost + r.price, prev, hopRt)) changed = true;
          }
        }
      }
    }
  }

  return (y, t) => {
    const end = best[t]?.get(keyOf(y, 1, '', all));
    if (!end) return null;
    const hops = [];
    for (let s = end; s.prev; s = best[s.prev.t].get(s.prev.key)) if (s.hop) hops.push(s.hop);
    return { cost: end.cost, hops: hops.reverse() };
  };
}

/** True when any flight leaves on the day the previous ticket lands (times to verify). */
function hasSameDay(d0, hops, backDate) {
  let landed = addDays(d0, 1);
  for (const h of hops.filter((x) => x.kind !== 'stay')) {
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
  for (const h of hops.filter((x) => x.kind !== 'stay')) {
    if (h.date <= landed) return false;
    landed = h.date;
  }
  return backDate > landed;
}

/**
 * A trip's tickets and flying order from its long legs and Asia plan, and where the Hoi An stay
 * falls: stay = { after: the order index of the flight landing before it, need: days from that
 * landing to the next flight } (details.js checks it against real times): `first` (a long round trip
 * or one-way), the plan's hops (a nested return's 'back' is the second flight of its 'rt'), and
 * `last` (the one-way home, or null when `first` is a round trip).
 */
function ticketsOf(first, hops, last) {
  const tickets = [first];
  const order = [[0, 'out']];
  const open = [];
  let stay = null;
  for (const h of hops) {
    if (h.kind === 'stay') { stay = { after: order.length - 1, need: h.need }; continue; }
    if (h.kind === 'back') { order.push([open.pop(), 'back']); continue; }
    const { kind, ...rest } = h;
    tickets.push({ kind, ...rest, cabin: 'Y' });
    order.push([tickets.length - 1, 'out']);
    if (kind === 'rt') open.push(tickets.length - 1);
  }
  if (last) { tickets.push(last); order.push([tickets.length - 1, 'out']); } else order.push([0, 'back']);
  return { tickets, order, stay };
}

/**
 * Where a trip actually stays: cities with at least a night between landing and the next flight
 * (a long haul lands the day after it leaves). A city only changed planes in doesn't count, so it
 * neither names the row (first, last: the first and last stays) nor appears in the via filter.
 */
function staysOf(trip, homes) {
  const at = (iso) => Date.parse(iso) / 864e5;
  const flights = trip.order.map(([i, dir]) => {
    const t = trip.tickets[i];
    const f = dir === 'back' ? { from: t.to, to: t.from, date: t.ret } : dir.startsWith('leg') ? t.legs[Number(dir.slice(3))] : t;
    const long = homes.includes(f.from) || homes.includes(f.to);
    return { from: f.from, to: f.to, leave: at(f.date), land: at(f.date) + (long ? 1 : 0) };
  });
  const stays = [];
  let first = null, last = null;
  for (let k = 1; k < flights.length; k++) {
    if (flights[k].leave - flights[k - 1].land < 1) continue;
    first ??= flights[k - 1].to;
    last = flights[k].from; // out of Vietnam overland: where the flight home leaves from
    for (const c of [flights[k - 1].to, flights[k].from]) if (!stays.includes(c)) stays.push(c);
  }
  return { stays, first, last };
}

/**
 * Every trip worth showing, as the cheapest per (home, class, in-city, out-city, departure month).
 *
 * fares: {
 *   homes, cities,                                  // e.g. ['YVR','YYJ'], ['DAD','ICN',…]
 *   anchors                            → { city: ground days to Hoi An } (Vietnam anchors)
 *   roundTrip(from, to, cabin, out)    → [{ ret, price }]   (any trip lengths Google priced)
 *   oneWay(from, to, cabin, date)      → price | null      (long legs, either direction)
 *   hop(from, to, date)                → price | null      (economy within Asia)
 *   asiaRT(from, to, date)             → [{ ret, price }]   (economy returns within Asia)
 *   departures                         → sorted ISO dates to try as day 0
 * }
 * Returns [{ home, cls: 'hybrid'|'economy', in, out, month, total, depart, ret, days, sameDay, safe, tickets, order, alts, fallbacks }],
 * tickets: [{ kind: 'rt'|'ow', from, to, date, ret?, cabin, price }]; order: the flights in flying
 * order as [ticket index, 'out'|'back'].
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
    const { stays, first, last } = staysOf(trip, fares.homes);
    trip.in = first;
    trip.out = last;
    for (const via of ['', ...stays]) keep(trip, via);
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
      const plan = hopPlans(x, d0, fares);
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
              ...ticketsOf({ kind: 'rt', from: home, to: x, date: d0, ret, cabin, price }, p.hops, null),
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
                ...ticketsOf({ kind: 'ow', from: home, to: x, date: d0, cabin, price: outPrice }, p.hops,
                  { kind: 'ow', from: y, to: home, date: ret, cabin, price: backPrice }),
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

export { buildTrips, similarCount, hopPlans, ticketsOf, staysOf, hasSameDay, isSafe, addDays };
