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
const { airportsOf, isLong } = require('../../../frontend/app/cities.js');
const { fareKey } = require('./fares');
const { samePrice } = require('../../../frontend/app/price.js');

const MIN_CONNECT_MIN = 4 * 60;
const CONCURRENCY = 12; // plain searches in flight (~2 s each)
const PAGES = 4; // browser pages at once (10-60 s each): a search waiting on one doesn't hold up the plain ones
const SLOW_PAGE_MS = 60_000; // retries and full lists: some searches (YYJ business returns) take Google > 30 s

const at = (date, hm) => Date.parse(`${date}T${hm}:00Z`) / 60000; // minutes, local clock (comparisons only within one city)
const arrival = (o) => at(o.legs.at(-1).arrDate, o.legs.at(-1).arr);
const cheapest = (opts) => opts.slice().sort((a, b) => a.price - b.price || a.min - b.min)[0];

const priceOf = (f, o) => (f.dir === 'out' ? o.price : 0); // a return's price is on its outbound
// A long connection on one ticket (not a stop between tickets, where you see the city): beyond
// SHORT_CONNECT, a penalty growing to the "same price" tolerance (price.js) of the ticket at LONG_CONNECT
// hours more, so a 3 h connection beats a 22 h one at about the same price.
const SHORT_CONNECT = 3 * 60;
const LONG_CONNECT = 21 * 60;
const connPen = (f, o) => {
  const over = (o.stops ?? []).reduce((sum, s) => sum + Math.max(0, s.min - SHORT_CONNECT), 0);
  return over && samePrice(f.ticket.cabin) * (f.dir === 'out' ? o.price : f.ticket.price) * Math.min(1, over / LONG_CONNECT);
};
const misses = (picks) => picks.filter((p) => p?.miss === 'connection').length;
/** Flight b (flight i of the trip) can follow a: leaves ≥ MIN_CONNECT after a lands, and keeps the Hoi An stay. */
function fits(stay, i, a, b) {
  if (at(b.legs[0].depDate, b.legs[0].dep) < arrival(a) + MIN_CONNECT_MIN) return false;
  return !stay || i !== stay.after + 1 || (Date.parse(b.legs[0].depDate) - Date.parse(a.legs.at(-1).arrDate)) / 864e5 >= stay.need;
}
/**
 * Each flight's pick: the cheapest flights that connect (long connections on a ticket count against
 * them: connPen), chosen together (a cheaper flight that
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
      next.push({ o, cost: (best?.cost ?? 0) + priceOf(f, o) + connPen(f, o), prev: best });
    }
    if (!next.length) { close(i); picks[i] = { miss: 'connection' }; continue; }
    layer = next;
  }
  close(flights.length);
  return picks;
}
/** browser limited to PAGES at once, across every addDetails call sharing `cache`. */
function paged(browser, cache) {
  const slots = (cache.pages ??= { free: PAGES, waiting: [] });
  return async (...args) => {
    if (slots.free) slots.free--;
    else await new Promise((go) => slots.waiting.push(go));
    try {
      return await browser(...args);
    } finally {
      const go = slots.waiting.shift();
      if (go) go(); else slots.free++;
    }
  };
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
 * connection has no flight, or the real flights leave the Hoi An stay short; null when a search
 * was skipped or failed). A ticket with a
 * listed flight takes its price (the graph's kept as `graph`) and the trip's total is re-summed. Pass the same `cache` across calls to reuse searches;
 * `browser` (query → GetShoppingResults payload) answers searches whose page inlined no results.
 * Returns { searches, failed, late, full, connection, none, stay } (full: full-list page loads; connection,
 * none: misses; stay: trips whose real flights leave the Hoi An stay short).
 * `listed` (optional Map): each searched fare's cheapest listed price, by fareKey (fares.js).
 * After `deadline` (ms) no new search starts: those flights stay unknown (stats.late: each
 * search counted once per cache, however many calls ask for it).
 */
async function addDetails(trips, cache = new Map(), browser = null, listed = null, deadline = Infinity) {
  const LATE = { error: 'out of time', late: true }; // not cached
  browser &&= paged(browser, cache);
  const searchOnce = (q) => {
    const key = JSON.stringify(q);
    if (!cache.has(key)) {
      if (Date.now() > deadline) return Promise.resolve(LATE);
      cache.set(key, search(q, { browser }).catch((e) => ({ error: e.message })));
    }
    return cache.get(key);
  };
  // A plain search lists only Google's top flights (the cheapest among them); when none of those
  // connects, or the search failed, the page's full list ("View more flights").
  const fullOnce = (q) => {
    const key = `full ${JSON.stringify(q)}`;
    if (!cache.has(key)) {
      if (Date.now() > deadline) return Promise.resolve(LATE);
      cache.set(key, browser(q, { timeout: SLOW_PAGE_MS }).then((ps) => ps.flatMap(parseResults)).catch((e) => ({ error: e.message })));
      stats.full++;
    }
    return cache.get(key);
  };
  const stats = { searches: 0, failed: 0, late: 0, full: 0, connection: 0, none: 0, stay: 0 };

  // Warm the cache with bounded concurrency, then pick sequentially per trip.
  const queries = [...new Map(trips.flatMap(flightsOf).map((f) => [JSON.stringify(f.query), f.query])).values()]
    .filter((q) => !cache.has(JSON.stringify(q)));
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < queries.length) await searchOnce(queries[next++]);
  }));
  cache.late ??= new Set();
  await Promise.all(queries.map(async (q) => {
    const r = await searchOnce(q);
    if (r.late) { if (!cache.late.has(JSON.stringify(q))) { cache.late.add(JSON.stringify(q)); stats.late++; } return; }
    stats.searches++;
    if (r.error && browser) { const all = await fullOnce(q); if (!all.late) cache.set(JSON.stringify(q), all); } // retried in a page
    if ((await searchOnce(q)).error) { stats.failed++; stats.error ??= `${q.from}-${q.to} ${q.out}: ${r.error}`; }
  }));

  // Trips picked CONCURRENCY at a time: a trip waiting on a full list (a page, 10-60 s) holds one.
  let nextTrip = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (nextTrip < trips.length) await pickFlights(trips[nextTrip++]);
  }));
  return stats;

  async function pickFlights(trip) {
    const flights = flightsOf(trip);
    const lists = await Promise.all(flights.map((f) => searchOnce(f.query)));
    // A plain search lists only Google's top flights; where none of those connects, the full list.
    let picks;
    for (const full = new Set(); ;) {
      picks = choose(trip, flights, lists);
      const i = browser ? picks.findIndex((p, j) => p?.miss === 'connection' && !full.has(j)) : -1;
      if (i < 0) break;
      full.add(i);
      const all = await fullOnce(flights[i].query);
      if (!all.error && all.length) lists[i] = all;
    }
    const s = settle(trip, flights, lists, picks);
    for (const [i, f] of flights.entries()) {
      f.ticket.flights ??= {};
      if (listed && f.dir === 'out' && !lists[i].error && lists[i].length && (f.ticket.kind === 'ow' || f.ticket.kind === 'rt')) listed.set(fareKey(f.ticket), cheapest(lists[i]).price);
      const pick = s.picks[i];
      if (!pick) continue; // search failed, or a return whose outbound is unknown
      f.ticket.flights[f.dir] = pick;
      if (pick.miss) { stats[pick.miss]++; continue; }
      // The listed price is what booking costs; the graph's can be stale (seen: $4,262 graph,
      // $5,012 cheapest listed).
      if (f.dir === 'out') { f.ticket.graph = f.ticket.price; f.ticket.price = pick.price; }
    }
    if (s.short) stats.stay++;
    trip.connects = s.connects;
    trip.conn = s.conn;
    trip.total = trip.tickets.reduce((sum, t) => sum + t.price, 0);
  }
}

/** Each flight's pick (plan), the Hoi An stay kept when any pick can, else as many connections as can be. */
function choose(trip, flights, lists) {
  const picks = plan(flights, lists, trip.stay);
  if (!trip.stay || !misses(picks)) return picks;
  const loose = plan(flights, lists);
  return misses(loose) < misses(picks) ? loose : picks;
}

/**
 * The picks made final: a return's flight back chosen, the long connections' penalty summed, and
 * whether the trip connects (false: a missed connection, or the real flights leave the Hoi An stay
 * short; null: a search skipped or failed). { picks, connects, conn, short }.
 */
function settle(trip, flights, lists, chosen) {
  const picks = [];
  let connects = true, conn = 0;
  for (const [i, f] of flights.entries()) {
    let pick = chosen[i];
    if (!pick || pick.miss) { picks.push(pick); if (pick?.miss === 'connection') connects = false; continue; }
    if (f.dir === 'back') {
      // A return's price is on its outbound, so which return goes with it is a guess: the same
      // airline as the outbound, of those that still fit the flights either side.
      const airlines = chosen[flights.findIndex((g) => g.ticket === f.ticket && g.dir === 'out')]?.airlines;
      if (!airlines) { picks.push(null); continue; } // unknown outbound: can't tell
      const [prev, next] = [chosen[i - 1], chosen[i + 1]].map((p) => (p?.legs ? p : null));
      const ok = lists[i].filter((o) => (!prev || fits(trip.stay, i, prev, o)) && (!next || fits(trip.stay, i + 1, o, next)));
      const same = ok.filter((o) => o.airlines.some((a) => airlines.includes(a)));
      pick = { ...(same.length ? same : ok).slice().sort((a, b) => connPen(f, a) - connPen(f, b) || a.price - b.price)[0], likely: true };
    }
    picks.push(pick);
    conn += connPen(f, pick);
  }
  // The Hoi An stay, from the real landing to the real departure: a flight that lands the next
  // day (overnight connection, long haul) eats into it. Short: not a trip, like a missed connection.
  let short = false;
  if (trip.stay) {
    const [a, b] = [picks[trip.stay.after], picks[trip.stay.after + 1]];
    if (a?.legs && b?.legs && (Date.parse(b.legs[0].depDate) - Date.parse(a.legs.at(-1).arrDate)) / 864e5 < trip.stay.need) { connects = false; short = true; }
  }
  // A search skipped (out of time) or failed: the trip is unknown, not a trip that connects.
  if (connects && lists.some((l) => l.error)) connects = null;
  return { picks, connects, conn, short };
}

// An option's longest single flight in minutes (a connection splits it: YVR-TPE-SGN is its YVR-TPE).
const longestLeg = (o) => Math.max(0, ...(o.legs ?? []).map((g) => g.min ?? 0));
/** The longest single flight on a checked trip's long-haul tickets, minutes (cities.js isLong; 0 when none is known). */
function longestOf(trip, homes) {
  return Math.max(0, ...trip.tickets.filter((t) => isLong(t.from, t.to, homes)).flatMap((t) => Object.values(t.flights ?? {}).map(longestLeg)));
}

/**
 * The trip with no single flight on its long-haul tickets (cities.js isLong) over `maxMin`, from searches
 * already in `cache` (the full list where there is one): its own copy with those flights and
 * their listed prices, or null when the searches aren't there or no such flights connect. No search
 * is made: the board's long-haul filter, from what the checks found.
 */
async function capped(trip, cache, maxMin, homes) {
  const flights = flightsOf(trip);
  const lists = [];
  for (const f of flights) {
    const key = JSON.stringify(f.query);
    let l = cache.has(`full ${key}`) ? await cache.get(`full ${key}`) : null;
    if (!Array.isArray(l) || !l.length) l = cache.has(key) ? await cache.get(key) : null;
    if (!Array.isArray(l) || !l.length) return null;
    if (isLong(f.ticket.from, f.ticket.to, homes)) l = l.filter((o) => longestLeg(o) <= maxMin);
    if (!l.length) return null;
    lists.push(l);
  }
  const s = settle(trip, flights, lists, choose(trip, flights, lists));
  if (s.connects !== true || s.picks.some((p) => !p?.legs)) return null;
  const copies = new Map(trip.tickets.map((t) => [t, { ...t, flights: {} }]));
  for (const [i, f] of flights.entries()) {
    const t = copies.get(f.ticket);
    t.flights[f.dir] = s.picks[i];
    if (f.dir === 'out') { t.graph = f.ticket.graph ?? f.ticket.price; t.price = s.picks[i].price; }
  }
  const tickets = trip.tickets.map((t) => copies.get(t));
  return { ...trip, tickets, conn: s.conn, connects: true, total: tickets.reduce((sum, t) => sum + t.price, 0) };
}

module.exports = { addDetails, flightsOf, capped, longestOf };
