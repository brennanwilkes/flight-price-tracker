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
const { searchPlain, parseResults, dedupe } = require('../gflights/flights');
const { airportsOf, isLong } = require('../../../frontend/app/cities.js');
const { fareKey } = require('./fares');
const { samePrice } = require('../../../frontend/app/price.js');
const { SELF_HOURS, SELF_PEN } = require('./multi');

const MIN_CONNECT_MIN = 4 * 60;
const CONCURRENCY = 12; // plain searches in flight (~2 s each)
const PAGES = 4; // browser pages at once (10-60 s each), by default: a search waiting on one doesn't hold up the plain ones
// Google refusing plain searches (HTTP 429, or a redirect to its "unusual traffic" page): none
// start for this long, so the price graphs on the same connection aren't refused too.
const BLOCKED_PAUSE_MS = 60_000;
// Refreshing a stale search (cache.stale) waits behind every search a check still needs.
const REFRESH_PRIO = 1e6;
// Lists served from cache.stale: their flights and times hold, their prices are only a hint.
const STALE = new WeakSet();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
/** A search that got its slot after the deadline: dropped, not a failure. */
class Late extends Error {}

/**
 * `n` slots shared by every addDetails call on `cache`: run(prio, deadline, job). The waiting job
 * with the lowest prio goes next (a dashboard cell's searches before a via cell's, any check
 * before a refresh). A job that gets its slot after `deadline` hands it on and throws Late: a
 * queue drained past the deadline ran builds minutes over.
 */
function slots(cache, name, n) {
  const s = ((cache.slots ??= {})[name] ??= { free: n, waiting: [] });
  const release = () => {
    if (!s.waiting.length) { s.free++; return; }
    let i = 0;
    for (let j = 1; j < s.waiting.length; j++) if (s.waiting[j].prio < s.waiting[i].prio) i = j;
    s.waiting.splice(i, 1)[0].go();
  };
  return async (prio, deadline, job) => {
    if (s.free) s.free--;
    else await new Promise((go) => s.waiting.push({ prio, go }));
    if (Date.now() > deadline) { release(); throw new Late(); }
    try {
      return await job();
    } finally {
      release();
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
 * Searches share CONCURRENCY plain slots and `pages` browser pages across every call on `cache`,
 * by `prio` (lowest first). `cache.stale` (optional Map, key → result): searches from earlier
 * builds, past their fresh hours, used at once (their flights; the fare's price stands, nothing
 * goes into `listed`) and searched again after everything else (cache.at loses the key: made now).
 * cache.tally counts across calls: empty pages, pages, full lists, refreshed, blocked (Google refusing plain searches).
 */
async function addDetails(trips, cache = new Map(), browser = null, listed = null, deadline = Infinity, { prio = 0, pages = PAGES } = {}) {
  const LATE = { error: 'out of time', late: true }; // not cached
  const plain = slots(cache, 'plain', CONCURRENCY);
  const page = browser && slots(cache, 'pages', pages);
  const tally = (cache.tally ??= { empty: 0, pages: 0, full: 0, refreshed: 0, blocked: 0, plain: 0, plainEmpty: 0, timeouts: 0, errors: 0, plainMs: [], pageMs: [] });
  const stale = cache.stale ?? new Map(); // key → result, from earlier builds past their fresh hours
  const stats = { searches: 0, failed: 0, late: 0, full: 0, connection: 0, none: 0, stay: 0 };
  // A result into the cache as it comes; out of time: out again, not a result.
  const settle0 = (key, p) => {
    const r = p.catch((e) => (e instanceof Late ? LATE : { error: e.message }))
      .then((v) => { if (v === LATE && cache.get(key) === r) cache.delete(key); return v; });
    cache.set(key, r);
    return r;
  };
  const fetchPlain = (p, q, tries) => plain(p, deadline, async () => {
    for (let w; (w = (cache.blockedUntil ?? 0) - Date.now()) > 0;) await sleep(w);
    const t0 = Date.now();
    try {
      const r = await searchPlain(q, tries);
      if (!r.length) tally.plainEmpty++;
      return r;
    } catch (e) {
      if (/HTTP (429|30\d)/.test(e.message)) { tally.blocked++; cache.blockedUntil = Date.now() + BLOCKED_PAUSE_MS; }
      if (/timeout|abort/i.test(e.message)) tally.timeouts++;
      else tally.errors++;
      throw e;
    } finally {
      tally.plain++;
      tally.plainMs.push(Date.now() - t0);
    }
  });
  const inPage = async (p, q, opts) => {
    const r = await page(p, deadline, async () => {
      tally.pages++;
      const t0 = Date.now();
      try { return await browser(q, opts); } finally { tally.pageMs.push(Date.now() - t0); }
    });
    return dedupe(r.flatMap(parseResults));
  };
  // Plain first; a page with none inlined, in a browser. (Asked again plain 20 s on, 0 of 291 had
  // them: 06:05 sweep, 2026-11-02.)
  const plainThenPage = async (q, p) => {
    const opts = await fetchPlain(p, q);
    if (opts.length || !page) return opts;
    tally.empty++;
    return inPage(p, q);
  };
  // A stale result serves now; a fresh one replaces it once searched, after every check's search.
  const refresh = (key, run) => {
    (cache.refreshing ??= new Set());
    if (cache.refreshing.has(key)) return;
    cache.refreshing.add(key);
    run(REFRESH_PRIO + prio).then((v) => {
      if (!Array.isArray(v) || !v.length || cache.has(key)) return;
      cache.set(key, Promise.resolve(v));
      cache.at?.delete(key); // made now
      stale.delete(key);
      tally.refreshed++;
    }, () => {});
  };
  const once = (key, run, p) => {
    if (cache.has(key)) return cache.get(key);
    const old = stale.get(key);
    if (old) { STALE.add(old); refresh(key, run); return Promise.resolve(old); }
    if (Date.now() > deadline) return Promise.resolve(LATE);
    return settle0(key, run(p));
  };
  const searchOnce = (q, key = JSON.stringify(q), p = prio) => once(key, (pp) => plainThenPage(q, pp), p);
  // A plain search lists only Google's top flights (the cheapest among them); when none of those
  // connects, or the search failed, the page's full list ("View more flights").
  const fullOnce = (q) => {
    const key = `full ${JSON.stringify(q)}`;
    if (!cache.has(key) && !stale.has(key)) { stats.full++; tally.full++; }
    return once(key, (pp) => inPage(pp, q, { timeout: SLOW_PAGE_MS }), prio);
  };

  // Each trip's flights and their search keys worked out once; every search not made yet started
  // (the slots order them), then each trip picked as its searches come in.
  const flown = trips.map((t) => flightsOf(t).map((f) => Object.assign(f, { key: JSON.stringify(f.query) })));
  const queries = [...new Map(flown.flat().map((f) => [f.key, f.query])).values()]
    .filter((q) => !cache.has(JSON.stringify(q)) && !stale.has(JSON.stringify(q)));
  cache.late ??= new Set();
  await Promise.all(queries.map(async (q) => {
    const key = JSON.stringify(q);
    const r = await searchOnce(q, key);
    if (r.late) { if (!cache.late.has(key)) { cache.late.add(key); stats.late++; } return; }
    stats.searches++;
    if (r.error && browser) { const all = await fullOnce(q); if (!all.late && !all.error) cache.set(key, Promise.resolve(all)); } // retried in a page
    const now = await searchOnce(q, key);
    if (now.error) { stats.failed++; stats.error ??= `${q.from}-${q.to} ${q.out}: ${now.error}`; }
  }));
  await Promise.all(trips.map((t, i) => pickFlights(t, flown[i])));
  return stats;

  async function pickFlights(trip, flights) {
    const lists = await Promise.all(flights.map((f) => searchOnce(f.query, f.key)));
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
      const old = STALE.has(lists[i]); // its listed prices from an earlier day: the fare's own price stands
      if (listed && !old && f.dir === 'out' && !lists[i].error && lists[i].length && (f.ticket.kind === 'ow' || f.ticket.kind === 'rt')) listed.set(fareKey(f.ticket), cheapest(lists[i]).price);
      const pick = s.picks[i];
      if (!pick) continue; // search failed, or a return whose outbound is unknown
      f.ticket.flights[f.dir] = pick;
      if (pick.miss) { stats[pick.miss]++; continue; }
      // The listed price is what booking costs; the graph's can be stale (seen: $4,262 graph,
      // $5,012 cheapest listed).
      if (f.dir === 'out' && !old) { f.ticket.graph = f.ticket.price; f.ticket.price = pick.price; }
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
    // A self-transfer: the previous flight on another ticket, landing within SELF_HOURS of this one leaving.
    const prev = picks[i - 1];
    if (prev?.legs && flights[i - 1].ticket !== f.ticket && pick.legs && at(pick.legs[0].depDate, pick.legs[0].dep) - arrival(prev) < SELF_HOURS * 60) conn += SELF_PEN;
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
    const got = async (k) => (cache.has(k) ? cache.get(k) : cache.stale?.get(k) ?? null);
    let l = await got(`full ${key}`);
    if (!Array.isArray(l) || !l.length) l = await got(key);
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

module.exports = { addDetails, flightsOf, capped, longestOf, slots, Late, STALE };
