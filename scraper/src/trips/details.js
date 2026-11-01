'use strict';
/* Detail pass: the actual flights behind the dashboard's top trips (gflights/flights.js).
 *
 * A trip's flights are picked together: the cheapest set where each leaves ≥ MIN_CONNECT after the
 * previous one lands (separate tickets, SCOPE), so a same-day connection the price graph couldn't
 * check gets checked here. A flight with no departure late enough is recorded as { miss: 'connection' }; a date Google
 * lists no flights for at all (schedules not loaded that far yet) as { miss: 'none' }.
 *
 * Writes `flights` onto each ticket: { out, back? } (back only for a round trip), each one
 * option: { price, min, airlines, legs: [{ code, airline, from, to, dep, arr, depDate, arrDate,
 * min, plane }], stops: [{ at, min }], likely? }.
 */
const { search, parseResults } = require('../gflights/flights');
const { airportsOf } = require('../../../frontend/app/cities.js');
const { fareKey } = require('./fares');

const MIN_CONNECT_MIN = 4 * 60;
const CONCURRENCY = 6; // searches in flight; a browser fallback (~10 s) holds one of these
const SLOW_PAGE_MS = 60_000; // retries and full lists: some searches (YYJ business returns) take Google > 30 s

const at = (date, hm) => Date.parse(`${date}T${hm}:00Z`) / 60000; // minutes, local clock (comparisons only within one city)
const arrival = (o) => at(o.legs.at(-1).arrDate, o.legs.at(-1).arr);
const cheapest = (opts) => opts.slice().sort((a, b) => a.price - b.price || a.min - b.min)[0];

const priceOf = (f, o) => (f.dir === 'out' ? o.price : 0); // a return's price is on its outbound
const misses = (picks) => picks.filter((p) => p?.miss === 'connection').length;
/** Flight b (flight i of the trip) can follow a: leaves ≥ MIN_CONNECT after a lands, and keeps the Hoi An stay. */
function fits(stay, i, a, b) {
  if (at(b.legs[0].depDate, b.legs[0].dep) < arrival(a) + MIN_CONNECT_MIN) return false;
  return !stay || i !== stay.after + 1 || (Date.parse(b.legs[0].depDate) - Date.parse(a.legs.at(-1).arrDate)) / 864e5 >= stay.need;
}
/**
 * Each flight's pick: the cheapest flights that connect, chosen together (a cheaper flight that
 * lands later can beat an earlier one if the next flight still connects). A shortest path over the
 * options, flight by flight. A failed search (null pick) breaks the chain; a flight with no listed
 * option is { miss: 'none' }, one where nothing connects { miss: 'connection' }.
 */
function plan(flights, lists, stay = null) {
  const picks = new Array(flights.length).fill(null);
  let layer = null; // the previous flight's options: [{ o, cost, prev }], cost of the cheapest path to each
  const close = (i) => { // pick along the cheapest path ending at flight i - 1
    let e = layer?.reduce((a, b) => (b.cost < a.cost ? b : a));
    for (let j = i - 1; e; j--, e = e.prev) picks[j] = e.o;
    layer = null;
  };
  for (const [i, f] of flights.entries()) {
    const opts = lists[i];
    if (opts.error || !opts.length) { close(i); picks[i] = opts.error ? null : { miss: 'none' }; continue; }
    const next = [];
    for (const o of opts.slice().sort((a, b) => a.price - b.price || a.min - b.min)) {
      let best = null;
      if (layer) for (const p of layer) if (fits(stay, i, p.o, o) && (!best || p.cost < best.cost)) best = p;
      if (layer && !best) continue;
      next.push({ o, cost: (best?.cost ?? 0) + priceOf(f, o), prev: best });
    }
    if (!next.length) { close(i); picks[i] = { miss: 'connection' }; continue; }
    layer = next;
  }
  close(flights.length);
  return picks;
}
/** The trip's flights in flying order (trip.order, build.js): [{ ticket, dir: 'out'|'back', query, price? }]. */
function flightsOf(trip) {
  return trip.order.map(([i, dir]) => {
    const t = trip.tickets[i];
    if (dir === 'back') return { ticket: t, dir, query: { from: airportsOf(t.to), to: airportsOf(t.from), out: t.ret, cabin: t.cabin } };
    const query = { from: airportsOf(t.from), to: airportsOf(t.to), out: t.date, cabin: t.cabin };
    return { ticket: t, dir, query: t.kind === 'rt' ? { ...query, ret: t.ret } : query, price: t.price };
  });
}
/**
 * Fill `flights` on the given trips' tickets, and set each trip's `connects` (false when some
 * connection has no flight, or the real flights leave the Hoi An stay short). A ticket with a
 * listed flight takes its price (the graph's kept as `graph`) and the trip's total is re-summed. Pass the same `cache` across calls to reuse searches;
 * `browser` (query → GetShoppingResults payload) answers searches whose page inlined no results.
 * Returns { searches, failed, full, connection, none, stay } (full: full-list page loads; connection,
 * none: misses; stay: trips whose real flights leave the Hoi An stay short).
 * `listed` (optional Map): each searched fare's cheapest listed price, by fareKey (fares.js).
 */
async function addDetails(trips, cache = new Map(), browser = null, listed = null) {
  const searchOnce = (q) => {
    const key = JSON.stringify(q);
    if (!cache.has(key)) cache.set(key, search(q, { browser }).catch((e) => ({ error: e.message })));
    return cache.get(key);
  };
  // A plain search lists only Google's top flights (the cheapest among them); when none of those
  // connects, or the search failed, the page's full list ("View more flights").
  const fullOnce = (q) => {
    const key = `full ${JSON.stringify(q)}`;
    if (!cache.has(key)) {
      cache.set(key, browser(q, { timeout: SLOW_PAGE_MS }).then((ps) => ps.flatMap(parseResults)).catch((e) => ({ error: e.message })));
      stats.full++;
    }
    return cache.get(key);
  };
  const stats = { searches: 0, failed: 0, full: 0, connection: 0, none: 0, stay: 0 };

  // Warm the cache with bounded concurrency, then pick sequentially per trip.
  const queries = [...new Map(trips.flatMap(flightsOf).map((f) => [JSON.stringify(f.query), f.query])).values()]
    .filter((q) => !cache.has(JSON.stringify(q)));
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < queries.length) await searchOnce(queries[next++]);
  }));
  stats.searches = queries.length;
  for (const q of queries) {
    const r = await searchOnce(q);
    if (r.error && browser) cache.set(JSON.stringify(q), await fullOnce(q)); // retried in a page
    if ((await searchOnce(q)).error) { stats.failed++; stats.error ??= `${q.from}-${q.to} ${q.out}: ${r.error}`; }
  }

  for (const trip of trips) {
    const flights = flightsOf(trip);
    const lists = await Promise.all(flights.map((f) => searchOnce(f.query)));
    // A plain search lists only Google's top flights; where none of those connects, the full list.
    let picks;
    for (const full = new Set(); ;) {
      picks = plan(flights, lists, trip.stay);
      if (trip.stay && misses(picks)) { const loose = plan(flights, lists); if (misses(loose) < misses(picks)) picks = loose; }
      const i = browser ? picks.findIndex((p, j) => p?.miss === 'connection' && !full.has(j)) : -1;
      if (i < 0) break;
      full.add(i);
      const all = await fullOnce(flights[i].query);
      if (!all.error && all.length) lists[i] = all;
    }
    trip.connects = true;
    for (const [i, f] of flights.entries()) {
      f.ticket.flights ??= {};
      if (listed && f.dir === 'out' && !lists[i].error && lists[i].length && (f.ticket.kind === 'ow' || f.ticket.kind === 'rt')) listed.set(fareKey(f.ticket), cheapest(lists[i]).price);
      let pick = picks[i];
      if (!pick) continue; // search failed: unknown
      if (pick.miss) {
        f.ticket.flights[f.dir] = pick;
        stats[pick.miss]++;
        if (pick.miss === 'connection') trip.connects = false;
        continue;
      }
      if (f.dir === 'back') {
        // A return's price is on its outbound, so which return goes with it is a guess: the same
        // airline as the outbound, of those that still fit the flights either side.
        const airlines = picks[flights.findIndex((g) => g.ticket === f.ticket && g.dir === 'out')]?.airlines;
        if (!airlines) continue; // unknown outbound: can't tell
        const [prev, next] = [picks[i - 1], picks[i + 1]].map((p) => (p?.legs ? p : null));
        const ok = lists[i].filter((o) => (!prev || fits(trip.stay, i, prev, o)) && (!next || fits(trip.stay, i + 1, o, next)));
        const same = ok.filter((o) => o.airlines.some((a) => airlines.includes(a)));
        pick = { ...cheapest(same.length ? same : ok), likely: true };
      }
      f.ticket.flights[f.dir] = pick;
      // The listed price is what booking costs; the graph's can be stale (seen: $4,262 graph,
      // $5,012 cheapest listed).
      if (f.dir === 'out') { f.ticket.graph = f.ticket.price; f.ticket.price = pick.price; }
    }
    // The Hoi An stay, from the real landing to the real departure: a flight that lands the next
    // day (overnight connection, long haul) eats into it. Short: not a trip, like a missed connection.
    if (trip.stay) {
      const [a, b] = [flights[trip.stay.after], flights[trip.stay.after + 1]].map((f) => f.ticket.flights[f.dir]);
      if (a?.legs && b?.legs) {
        const days = (Date.parse(b.legs[0].depDate) - Date.parse(a.legs.at(-1).arrDate)) / 864e5;
        if (days < trip.stay.need) { trip.connects = false; stats.stay++; }
      }
    }
    trip.total = trip.tickets.reduce((sum, t) => sum + t.price, 0);
  }
  return stats;
}

module.exports = { addDetails, flightsOf };
