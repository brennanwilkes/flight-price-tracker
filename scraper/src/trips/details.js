'use strict';
/* Detail pass: the actual flights behind the dashboard's top trips (gflights/flights.js).
 *
 * Flights are picked in flying order, each leaving ≥ MIN_CONNECT after the previous one lands
 * (separate tickets, SCOPE), so a same-day connection the price graph couldn't check gets checked
 * here. A flight with no departure late enough is recorded as { miss: 'connection' }; a date Google
 * lists no flights for at all (schedules not loaded that far yet) as { miss: 'none' }.
 *
 * Writes `flights` onto each ticket: { out, back? } (back only for a round trip), each one
 * option: { price, min, airlines, legs: [{ code, airline, from, to, dep, arr, depDate, arrDate,
 * min, plane }], stops: [{ at, min }], likely? }.
 */
const { search } = require('../gflights/flights');

const MIN_CONNECT_MIN = 4 * 60;
const CONCURRENCY = 4;
const PRICE_TOL = 0.03;

const at = (date, hm) => Date.parse(`${date}T${hm}:00Z`) / 60000; // minutes, local clock (comparisons only within one city)
const arrival = (o) => at(o.legs.at(-1).arrDate, o.legs.at(-1).arr);
const cheapest = (opts) => opts.slice().sort((a, b) => a.price - b.price || a.min - b.min)[0];

/** The trip's flights in flying order: [{ ticket, dir: 'out'|'back', query, price?, sameAirlineAs? }]. */
function flightsOf(trip, homes) {
  const rt = trip.tickets.find((t) => t.kind === 'rt');
  const longs = trip.tickets.filter((t) => homes.includes(t.from) || homes.includes(t.to));
  const hops = trip.tickets.filter((t) => !longs.includes(t)).sort((a, b) => a.date.localeCompare(b.date));
  const one = (t) => ({ ticket: t, dir: 'out', query: { from: t.from, to: t.to, out: t.date, cabin: t.cabin }, price: t.price });
  if (rt) {
    return [
      { ticket: rt, dir: 'out', query: { from: rt.from, to: rt.to, out: rt.date, ret: rt.ret, cabin: rt.cabin }, price: rt.price },
      ...hops.map(one),
      { ticket: rt, dir: 'back', query: { from: rt.to, to: rt.from, out: rt.ret, cabin: rt.cabin } },
    ];
  }
  const [first, last] = longs.sort((a, b) => a.date.localeCompare(b.date));
  return [one(first), ...hops.map(one), ...(last ? [one(last)] : [])];
}
/**
 * Fill `flights` on the given trips' tickets, and set each trip's `connects` (false when some
 * connection has no flight). A ticket with a listed flight takes its price (the graph's kept as
 * `graph`) and the trip's total is re-summed. Pass the same `cache` across calls to reuse searches.
 * Returns { searches, failed, connection, none } (the last two: misses).
 */
async function addDetails(trips, homes, cache = new Map()) {
  const searchOnce = (q) => {
    const key = JSON.stringify(q);
    if (!cache.has(key)) cache.set(key, search(q).catch((e) => ({ error: e.message })));
    return cache.get(key);
  };
  const stats = { searches: 0, failed: 0, connection: 0, none: 0 };

  // Warm the cache with bounded concurrency, then pick sequentially per trip.
  const queries = [...new Map(trips.flatMap((t) => flightsOf(t, homes)).map((f) => [JSON.stringify(f.query), f.query])).values()]
    .filter((q) => !cache.has(JSON.stringify(q)));
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < queries.length) await searchOnce(queries[next++]);
  }));
  stats.searches = queries.length;
  for (const q of queries) {
    const r = await searchOnce(q);
    if (r.error) { stats.failed++; stats.error ??= `${q.from}-${q.to} ${q.out}: ${r.error}`; }
  }

  for (const trip of trips) {
    let landed = null; // minutes, of the previous flight's arrival
    let outAirlines = null;
    const flights = flightsOf(trip, homes);
    trip.connects = true;
    for (const [i, f] of flights.entries()) {
      const opts = await searchOnce(f.query);
      f.ticket.flights ??= {};
      if (opts.error) { landed = null; continue; } // unknown: don't judge the next connection
      const ok = opts.filter((o) => landed == null || at(o.legs[0].depDate, o.legs[0].dep) >= landed + MIN_CONNECT_MIN);
      let pick;
      if (f.dir === 'back') {
        const same = ok.filter((o) => o.airlines.some((a) => outAirlines?.includes(a)));
        pick = cheapest(same.length ? same : ok);
        if (pick) pick = { ...pick, likely: true };
      } else {
        // Of the flights at the graph's price, the one landing earliest leaves the most room for
        // the next connection (the last flight just takes the cheapest). Nothing at that price
        // that connects: the cheapest that does, its own price shown.
        const atPrice = ok.filter((o) => o.price <= f.price * (1 + PRICE_TOL) + 5);
        pick = !atPrice.length ? cheapest(ok)
          : i === flights.length - 1 ? cheapest(atPrice)
          : atPrice.slice().sort((a, b) => arrival(a) - arrival(b) || a.price - b.price)[0];
      }
      if (!pick) {
        const miss = opts.length ? 'connection' : 'none';
        f.ticket.flights[f.dir] = { miss };
        stats[miss]++;
        if (miss === 'connection') trip.connects = false;
        landed = null;
        continue;
      }
      if (f.ticket.kind === 'rt' && f.dir === 'out') outAirlines = pick.airlines;
      f.ticket.flights[f.dir] = pick;
      // The listed price is what booking costs; the graph's can be stale (seen: $4,262 graph,
      // $5,012 cheapest listed). A return's price is on its outbound.
      if (f.dir === 'out') { f.ticket.graph = f.ticket.price; f.ticket.price = pick.price; }
      landed = arrival(pick);
    }
    trip.total = trip.tickets.reduce((sum, t) => sum + t.price, 0);
  }
  return stats;
}

module.exports = { addDetails, flightsOf };
