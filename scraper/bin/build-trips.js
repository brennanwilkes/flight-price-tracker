#!/usr/bin/env node
'use strict';
/* Build trips from the data branch's current fares and write what the dashboard reads:
 *
 *   derived/trips-<HOME>.json   { generatedAt, home, rows: [{ in, out, set, hybrid, economy, months: { "<YYYY-MM>": { hybrid, economy } } }] }
 *   derived/history/<YYYY-MM>.csv   (src/trips/history.js)
 *
 * One row per crossing (in: where the long flight out lands, out: where the long flight home
 * leaves) and throw-ins (set: other cities with 2+ nights, build.js setOf); each cell is the row's
 * cheapest trip (null when none), overall and per departure month. Each crossing's cheapest trip
 * is in its row (checked first); its other rows are the cheapest found for their cities, at most
 * THROW_INS per crossing and class (the cheapest), and each city's cheapest row that sleeps there.
 * Rows sorted by cheapest hybrid, then cheapest economy. Overall cells carry `was`: the cell's total 24 h earlier, when known.
 *
 *   derived/via/trips-<HOME>-<CITY>.json   the same rows (no `was`), each cell the cheapest trip
 *                                           staying in CITY: the dashboard's via filter
 *
 *   derived/filters-<HOME>.json   the dashboard's length and long-haul filters, loaded when used:
 *       { generatedAt, home, caps, rows: { <rowId>: { bands: { "<first day>": { hybrid, economy } },
 *         fast: { hybrid, economy, months: { "<YYYY-MM>": { hybrid, economy } } } } } }
 *     bands: the cheapest trip per two-day length band (build.js bandOf); fast (and each band
 *     trip's own fast): { "<cap hours>": trip | null } for the caps where the cell's trip changes
 *     (CAPS): the cell under a cap is the one at the tightest listed cap at or above it.
 *
 * Each file stores a distinct ticket once (frontend/app/pack.js).
 *
 * Every cell, overall and per month, gets the actual flights on each ticket
 * (src/trips/details.js; skipped with --no-details), and the listed prices: the price graph has
 * no times and can be stale, so a cell's cheapest trip may not connect or may cost more as listed.
 * Further candidates (any month for an overall cell, plus the builder's fallbacks) are checked
 * while they could still be cheaper, up to TRIES (verify), and rows re-sort on the checked totals.
 * The listed prices found replace the graph's (state/checked.json, kept CHECKED_HOURS), and the
 * trips are built and checked again, up to ROUNDS, until no fare lists at a new price: a hop
 * graphed $138 on every day but listed $232 on the one picked moves to a day listed cheaper.
 *
 *   derived/fares.json   the fares the trips were built from (fares.js bundleOf), for the page's
 *                        own builds: the via filter with several cities
 *
 *   derived/status.json   for the Health tab: this build's detail-check stats, the newest departure day with fares (frontier), each route's
 *                         freshness (cells, oldest and newest sighting), the alert thresholds
 *
 *   node scraper/bin/build-trips.js --data <dataDir> [--no-details] [--deadline <epoch seconds>] [--search-cache <file.json.gz>]
 *
 * --search-cache: a file keeping the flight checks' search results across builds, each reused for
 * SEARCH_HOURS (CI keeps it in the Actions cache): most cells are the same trips hour to hour.
 *
 * --deadline: when the build must be done (CI's job limit). Flight checks start no search after
 * DETAILS_RESERVE before it, the multi-city pass searches only with MULTI_RESERVE left.
 *
 * --warm <epoch seconds>: flight checks only, until then (no new search after it), into the search
 * cache; nothing else written. CI runs this beside the scrape on a snapshot of the data, so the
 * build after it starts with those searches made.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const config = require('../config/sweep.json');
const { staleAfterHours } = require('../src/sweep/plan');
const { loadFares, bundleOf, fareOf } = require('../src/trips/fares');
const { similarCount, scoreOf, rowId, bandOf } = require('../../frontend/app/build.js');
const { CITIES, airportsOf, isPacific } = require('../../frontend/app/cities.js');
const { recordHistory, valuesAt, keyOf } = require('../src/trips/history');
const { addDetails, returnsDone, returnsFor, capped, longestOf, listedOnly, unlistedWhy, useBookings } = require('../src/trips/details');
const { loadBookings, saveBookings, applyBookings, stripBookings, bookingCandidates, bookingPass } = require('../src/trips/bookings');
const { inCabin, bookingUrl } = require('../src/gflights/booking');
const { openBrowserThread } = require('../src/gflights/browser-thread');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const alertConfig = require('../config/alerts.json');
const { tierOf } = require('../src/alerts/rules');
const { flexOf } = require('../../frontend/app/flex.js');
const { packJson } = require('../../frontend/app/pack.js');
const { markLows, cellTrips } = require('../src/trips/lows');
const { applyMulti, multiCache, multiSaving } = require('../src/trips/multi');
const { buildTripsThreaded } = require('../src/trips/threads');

const CLASSES = ['hybrid', 'economy'];
const TRIES = 10;
const FAST_PRIO = 100 * TRIES; // after every rank's searches (ranks 0-9)
const MAX_FILE_BYTES = 95e6; // GitHub refuses a pushed file over 100 MB
const THROW_INS = 4; // rows per crossing and class besides the one with its cheapest
const MULTI_BUDGET = 80; // multi-city searches per build (trips/multi.js)
const PACIFIC_MULTI = 30; // of them, at most this many for trips through a Pacific stop first
const ROUNDS = 3;
const CHECKED_HOURS = 24;
// Flight checks stop starting searches this long before the deadline: the ones in flight and the
// picks after them run ~4.5 min on (02:05 sweep, 2026-11-02), then the multi-city pass needs
// MULTI_RESERVE; at 8 min it never ran.
const DETAILS_RESERVE = 13 * 60e3;
const MULTI_RESERVE = 5 * 60e3;
const MULTI_STOP = 2.5 * 60e3;
// Booking pages (bookings.js): beside the scrape (warm) up to BOOKING_WARM_MS, in the build what
// time the checks leave before the multi-city pass, at most BOOKING_BUILD_MS. Pages at once: ~3-4 s each.
// 12:05 pm sweep 2026-11-12 (Vancouver VPN server): 652 pages in 16 min at 4, 293 in the build in 3.6 min
// at 6, ~945 a run; the queue was 15,555 and an entry lasts BOOKING_HOURS, so ~1,100-1,300 a run are
// needed to keep it all checked. The scrape runs ~24-26 min: the pass runs on to ~22, past the flight
// checks (WARM_UNTIL, ~20), at 6 pages.
const BOOKING_WARM_MS = 22 * 60e3;
const BOOKING_BUILD_MS = 3 * 60e3;
const BOOKING_PAGES = { warm: 6, build: 6 };
const QUEUE_MAX = 20000; // every board ticket (~9,600 on 2026-11-12) and its other outbounds; at 8000 the short hops, queued last, never made it in
// A ticket as the booking pass needs it (--booking-queue).
const slimLegs = (f) => f && { legs: f.legs.map(({ code, from, to, depDate }) => ({ code, from, to, depDate })) };
const slim = (t) => ({ kind: t.kind, from: t.from, to: t.to, date: t.date, ret: t.ret, cabin: t.cabin, price: t.price, flights: { out: slimLegs(t.flights.out), back: slimLegs(t.flights.back) } });
// A day's flights and times hold for a day; their listed prices are trusted as long (CHECKED_HOURS)
// and the fares behind them are 2-48 h old already. Every shown cell needs ~6,200 searches, a build
// makes ~800: under SEARCH_HOURS = 3 they could never all be fresh at once.
const SEARCH_HOURS = 24;
// Past SEARCH_HOURS a search still serves, up to STALE_DAYS (details.js cache.stale): a day's
// flights and times rarely change, so its cell stays checked while it waits to be searched again,
// after every search a check still needs. Cells with no flights checked come only from searches
// never made, not from the ones a day of checks couldn't all redo.
const STALE_DAYS = 7;
// Browser pages at once: 4 beside the scrape (its price graphs run too), more in the build.
const PAGES = { warm: 4, build: 8 };
// Any listed flight lands within this many days of leaving; a longer offset is a misread row.
const MAX_LAND_DAYS = 3;
// The board's long-haul filter (hours, loosest first): each dashboard cell's cheapest trip with
// no single flight (connections apart) on its long-haul tickets longer, re-picked from its checked
// candidates' searches.
const CAPS = [18, 16, 15, 14, 13, 12, 11, 10];
const SEARCH_PER_CAP = 2; // round trips' returns searched per long-haul cap per cell

/**
 * Search results from earlier builds, under SEARCH_HOURS old: { cache: key → result, at: key → ISO
 * time, lands: landings of them }.
 */
function loadSearches(file, now) {
  const cache = new Map(), at = new Map(), stale = new Map(), rows = [];
  if (file && fs.existsSync(file)) {
    try {
      for (const [k, when, v] of readRows(zlib.gunzipSync(fs.readFileSync(file)))) {
        const age = now - Date.parse(when);
        if (age >= STALE_DAYS * 864e5) continue;
        at.set(k, when);
        rows.push([k, v]);
        if (age < SEARCH_HOURS * 3600e3) cache.set(k, Promise.resolve(v));
        else stale.set(k, v);
      }
    } catch (e) {
      console.log(`search cache unreadable, starting empty: ${e.message}`);
    }
  }
  cache.at = at;
  cache.stale = stale;
  return { cache, at, stale, lands: landings(rows) };
}

/**
 * "from|to|date" (cities) → days after leaving that the earliest listed flight lands, over every
 * search of that flight (cabins, plain and full lists): the builder plans with it (fares.js lands),
 * so a trip whose every flight lands too late for the next one, or for the Hoi An stay, isn't
 * proposed and searched only to fail.
 */
function landings(rows) {
  const cityOf = new Map(Object.keys(CITIES).map((c) => [JSON.stringify(airportsOf(c)), c]));
  const out = new Map();
  for (const [k, opts] of rows) {
    const q = JSON.parse(k.replace(/^full /, ''));
    if (q.selected) continue; // a round trip's returns, listed under its outbound's search
    const [from, to] = [q.from, q.to].map((a) => cityOf.get(JSON.stringify(a)) ?? a);
    const days = Math.min(...opts.map((o) => (Date.parse(o.legs.at(-1).arrDate) - Date.parse(q.out)) / 864e5));
    const key = `${from}|${to}|${q.out}`;
    if (Number.isFinite(days) && days <= MAX_LAND_DAYS && !(out.get(key) <= days)) out.set(key, days);
  }
  return out;
}
/** The saved cache's rows: a row per line, or (an older file) one JSON array. */
function* readRows(buf) {
  if (buf.indexOf(10) < 0) { if (buf.length) yield* JSON.parse(buf); return; }
  for (let i = 0; i < buf.length;) {
    let j = buf.indexOf(10, i);
    if (j < 0) j = buf.length;
    if (j > i) yield JSON.parse(buf.subarray(i, j));
    i = j + 1;
  }
}
/** This build's successful searches, with the time each was made, and the stale ones not searched again. */
async function saveSearches(file, { cache, at }, now) {
  if (!file) return;
  const rows = [];
  for (const [k, p] of cache) {
    const v = await p;
    if (Array.isArray(v) && v.length) rows.push([k, at.get(k) ?? now, stripBookings(v)]);
  }
  const fresh = rows.length;
  for (const [k, v] of cache.stale ?? []) if (!cache.has(k)) rows.push([k, at.get(k), stripBookings(v)]);
  // A row per line: the whole cache as one string is past V8's string limit (seen: RangeError:
  // Invalid string length, every other build from 03:05 UTC Nov 5).
  const gz = zlib.createGzip();
  const done = new Promise((ok, fail) => gz.pipe(fs.createWriteStream(file)).on('finish', ok).on('error', fail));
  for (const r of rows) if (!gz.write(`${JSON.stringify(r)}\n`)) await new Promise((ok) => gz.once('drain', ok));
  gz.end();
  await done;
  console.log(`search cache: ${rows.length} kept (${fresh} under ${SEARCH_HOURS} h old)`);
}

/**
 * Every shown cell's trip costs what its flights were listed at (details.js listedOnly): any
 * other (a round trip's return only guessed among them), and the cell isn't shown.
 */
function dropUnlisted(byHome) {
  let dropped = 0;
  const why = {};
  const ok = (t) => { const w = unlistedWhy(t); if (!w) return true; dropped++; why[w] = (why[w] ?? 0) + 1; return false; };
  for (const rows of byHome.values()) {
    for (const r of rows) {
      const holders = [r, ...Object.values(r.months ?? {}), ...Object.values(r.bands ?? {})];
      for (const h of holders) {
        for (const cls of CLASSES) {
          const c = h[cls];
          if (!c) continue;
          if (!ok(c)) { h[cls] = null; continue; }
          for (const [k, t] of Object.entries(c.fast ?? {})) if (t && !ok(t)) c.fast[k] = null;
        }
      }
    }
  }
  return { dropped, why };
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

// How a candidate ranks: scoreOf, less what one ticket would save it at a cached multi-city price
// (a real search, under a day old): a trip only cheap as one ticket competes as such, before the
// multi-city pass merges it. Set in main.
let rankOf = scoreOf;

function rowsFor(home, trips, via = '') {
  const rows = new Map();
  for (const t of trips) {
    if (t.home !== home || t.via !== via) continue;
    const key = rowId(t);
    if (!rows.has(key)) rows.set(key, { in: t.in, out: t.out, set: t.set, hybrid: null, economy: null, months: {} });
    const row = rows.get(key);
    row.months[t.month] ??= { hybrid: null, economy: null };
    row.months[t.month][t.cls] ??= strip(t);
    if (!via) {
      row.bands ??= {};
      row.bands[bandOf(t.days)] ??= { hybrid: null, economy: null };
      row.bands[bandOf(t.days)][t.cls] ??= strip(t);
    }
    row.cands ??= { hybrid: [], economy: [] };
    row.cands[t.cls].push(t, ...t.fallbacks);
  }
  for (const row of rows.values()) {
    for (const cls of CLASSES) {
      row.cands[cls].sort((a, b) => rankOf(a) - rankOf(b));
      row[cls] = overall(row.cands[cls][0], trips);
    }
  }
  // Per crossing and class: the row with the cheapest (top: checked first) and THROW_INS more,
  // and every city's cheapest row that sleeps there, so no city is crowded off the board.
  const rank = (r, cls) => rankOf(r.cands[cls][0]);
  const kept = new Map(CLASSES.map((cls) => [cls, new Set()]));
  if (!via) for (const cls of CLASSES) { // a via view is one city's already
    const byCity = new Map();
    for (const r of rows.values()) {
      if (!r[cls] || !r.set) continue;
      for (const c of r.set.split('+')) if (!byCity.has(c) || rank(r, cls) < rank(byCity.get(c), cls)) byCity.set(c, r);
    }
    for (const r of byCity.values()) { kept.get(cls).add(r); (r.city ??= {})[cls] = true; }
  }
  const crossings = Map.groupBy([...rows.values()], (r) => `${r.in}-${r.out}`);
  for (const list of crossings.values()) {
    for (const cls of CLASSES) {
      const has = list.filter((r) => r[cls]).sort((a, b) => rank(a, cls) - rank(b, cls));
      has.forEach((r, i) => {
        if (i === 0) (r.top ??= {})[cls] = true;
        if (i <= THROW_INS || kept.get(cls).has(r)) return;
        r[cls] = null;
        for (const m of [...Object.values(r.months), ...Object.values(r.bands ?? {})]) m[cls] = null;
      });
    }
  }
  return sortRows([...rows.values()].filter((r) => r.hybrid || r.economy));
}

// A trip as the dashboard stores it, without the builder's keys.
// tier: the price tier word (config/alerts.json), shared with the alerts.
const strip = ({ home, in: _i, out: _o, set: _s, cls, month, safe, fallbacks, via, ...trip }) => ({ ...trip, tier: tierOf(alertConfig, cls, trip.total) });
// A checked cell: its own copy of the tickets (flight details go there; a trip can be both an
// overall and a month cell) and +N counted across months, or in `month`.
const overall = (t, trips, month = null) => t && { ...strip(t), tickets: t.tickets.map((x) => ({ ...x })), alts: t.via ? 0 : similarCount(trips.dateSets, t, month) };
const price = (t) => t?.total ?? Infinity;
const sortRows = (rows) => rows.sort((a, b) => price(a.hybrid) - price(b.hybrid) || price(a.economy) - price(b.economy));

/**
 * Check every row's cells, overall and per month, against real flights (byHome: any map of row
 * lists). Each cell walks its candidates best first (scoreOf: price plus trip-shape penalties,
 * graph prices; a month cell only that month's), keeping the best that connects at listed prices
 * (long connections on a ticket now counted too), until the next candidate's builder score can't
 * beat it, or after TRIES. None connects, or none with its flights checked (searches skipped out
 * of time): the cell is dropped (a row with no overall
 * cell goes too); a trip that can't be flown is not a price. Searches are shared, so a month cell
 * walking the same trips as its overall cell costs nothing more. session: { cache, browser,
 * listed, deadline } shared across rounds (main). Searched in order of what matters most: the
 * dashboard's overall cells with each crossing's cheapest, each city's cheapest row, its other
 * overall cells, the month cells alike, then the via filter's the same way; past the deadline the
 * rest are dropped unless a checked candidate stands in (st.late: searches not made).
 */
// A walk whose searches are all cached runs on promise callbacks alone, which never let the event
// loop in: 215k cells held it 215 s (11:05 sweep, 2026-11-02), searches and page replies waiting.
// Every BREATHE_MS of it, a turn for everything else.
const BREATHE_MS = 50;
const WALKS = 400; // cells checked at once: searches pending for 400 keep every search slot busy
// One turn shared by every walk that runs out of time: the window restarts when the turn comes,
// not as each walk resumes (each resuming walk restarting it ran them all in one go again).
let breath = Date.now();
let turn = null;
function breathe() {
  if (Date.now() - breath < BREATHE_MS) return null;
  return (turn ??= new Promise((r) => setImmediate(() => { turn = null; breath = Date.now(); r(); })));
}

async function verify(byHome, trips, { cache, browser, listed, deadline, pages, warm = false }) {
  const t0 = Date.now();
  const st = { cells: 0, replaced: 0, unresolved: 0, unknown: 0, searches: 0, failed: 0, late: 0, none: 0, stay: 0, detailsMs: 0 };
  const cellsOf = (r, base) => CLASSES.filter((c) => r[c]).flatMap((cls) => [
    { rank: base + (r.top?.[cls] ? 0 : r.city?.[cls] ? 1 : 2), cls, cands: r.cands[cls], cand: r[cls], put: (t) => { r[cls] = t; } },
    ...Object.entries(r.months).filter(([, m]) => m[cls]).map(([month, m]) => {
      const cands = r.cands[cls].filter((t) => t.depart.startsWith(month));
      return { rank: base + (r.top?.[cls] ? 3 : 4), cls, month, cands, cand: overall(cands[0], trips, month), put: (t) => { m[cls] = t; } };
    }),
    ...Object.entries(r.bands ?? {}).filter(([, b]) => b[cls]).map(([band, b]) => {
      const cands = r.cands[cls].filter((t) => bandOf(t.days) === Number(band));
      return { rank: base + 4, cls, cands, cand: overall(cands[0], trips), put: (t) => { b[cls] = t; } };
    }),
  ]);
  const cells = [...byHome].flatMap(([view, rows]) => rows.flatMap((r) => cellsOf(r, view.endsWith('|') ? 0 : 5)))
    .map((p) => ({ ...p, i: 0, best: null, first: null }));
  st.cells = cells.length;
  // Every cell walks its candidates at once; the searches go by rank then try (details.js slots):
  // a dashboard cell's later candidates before any via cell's first.
  const backs = [];
  const step = (p) => {
    p.first ??= p.cand;
    if (p.cand.connects) (p.checked ??= []).push(p.cand);
    if (p.cand.connects === null) p.unknown = true;
    if (p.cand.connects && !(p.best && rankOf(p.best) <= rankOf(p.cand))) p.best = p.cand;
    const next = p.cands[++p.i];
    // conn is only known once checked: a candidate's rank can only rise from its builder rank.
    if (next && p.i < TRIES && !(p.best && rankOf(next) >= rankOf(p.best))) {
      p.cand = overall(next, trips, p.month);
      return true;
    }
    if (p.best) p.best.tier = tierOf(alertConfig, p.cls, p.best.total);
    // Its round trips' returns searched now, after this rank's checks and before the next rank's:
    // a return proves the cell's price as much as a check finds its flights.
    if (p.best) backs.push(returnsFor(cache, p.best, p.rank * TRIES + TRIES - 0.5));
    // Its long-haul filter cells (dashboard only), their returns searched after every cell's own
    // (interleaved, they took ~1,000 returns a build from via cells: 2026-11-09, hidden 1.4k → 2.1k).
    if (p.best && p.rank < 5 && !warm) { const best = p.best; backs.push(backs.at(-1).then(() => fastOf({ ...p, best }, cache, FAST_PRIO + p.rank))); }
    p.put(p.best);
    if (!p.best) st[p.unknown ? 'unknown' : 'unresolved']++;
    else if (p.best !== p.first) st.replaced++;
    return false;
  };
  const td = Date.now();
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  // WALKS cells at a time, dashboard first: 215k walks at once each resumed through a whole cached
  // check in one go, holding the event loop seconds at a time.
  const queue = cells.slice().sort((a, b) => a.rank - b.rank);
  let next = 0;
  await Promise.all(Array.from({ length: WALKS }, async () => { for (let p; (p = queue[next++]);) {
    do {
      await breathe();
      const s = await addDetails([p.cand], cache, browser, listed, deadline, { prio: p.rank * TRIES + p.i, pages });
      st.searches += s.searches;
      st.failed += s.failed;
      st.late += s.late;
      st.error ??= s.error;
      st.none += s.none;
      st.stay += s.stay;
    } while (step(p));
  } }));
  const t1 = Date.now();
  await Promise.all(backs); // the cells' returns and long-haul filter cells
  st.fastMs = Date.now() - t1;
  await returnsDone(cache, new Set()); // none left a cell kept: dropped
  st.detailsMs = Date.now() - td;
  lag.disable();
  st.lag = `${(lag.percentile(99) / 1e6).toFixed(0)} ms 99%, ${(lag.max / 1e6).toFixed(0)} ms max`;
  for (const [view, rows] of byHome) {
    for (const r of rows) { delete r.cands; delete r.top; delete r.city; }
    byHome.set(view, sortRows(rows.filter((r) => r.hybrid || r.economy)));
  }
  return { ...st, ms: Date.now() - t0 };
}

/**
 * A cell's trips under each long-haul cap (CAPS), from its checked candidates: best.fast = {
 * "<cap>": trip | null } where the cell's trip changes, loosest first (a cap its trip already
 * keeps to needs nothing; none under a cap: null, and every tighter cap is none too).
 */
async function fastOf(p, cache, prio = Infinity) {
  const homes = config.origins;
  const fast = {};
  let cur = p.best;
  for (const cap of CAPS) {
    if (longestOf(cur, homes) <= cap * 60) continue;
    // Each checked trip under the cap, best first; the first priced as listed wins. One whose
    // round trip's return isn't searched yet has no price: searched (SEARCH_PER_CAP at most).
    const under = [];
    for (const c of p.checked ?? []) {
      await breathe();
      const t = await capped(c, cache, cap * 60, homes);
      if (t) under.push([c, t]);
    }
    if (!under.length) { fast[cap] = null; break; } // none under it: none under a tighter one either
    under.sort(([, a], [, b]) => rankOf(a) - rankOf(b));
    let best = null;
    let tries = SEARCH_PER_CAP;
    for (let [c, t] of under) {
      if (best && rankOf(t) >= rankOf(best)) break; // an unpriced trip ranks at its best case
      if (!listedOnly(t) && tries-- > 0) t = await capped(c, cache, cap * 60, homes, { search: (q) => cache.searchReturn?.(q, prio) });
      if (t && listedOnly(t) && !(best && rankOf(best) <= rankOf(t))) best = t;
    }
    fast[cap] = best && { ...best, tier: tierOf(alertConfig, p.cls, best.total) };
    if (best) cur = best;
  }
  if (Object.keys(fast).length) p.best.fast = fast;
}

/**
 * Multi-city single tickets (trips/multi.js) for the shown cells: the main views' overall cells
 * searched, most promising first (an open jaw estimated at the cheaper return to either end, which
 * is about what airlines charge); the via views and the month cells take the cached prices only.
 * Re-tiers and re-sorts the rows.
 */
async function multiPass(dataDir, byHome, fares, search, until = Infinity) {
  const monthCells = (r) => [...Object.values(r.months), ...Object.values(r.bands ?? {})].flatMap((m) => CLASSES.map((cls) => m[cls] && Object.assign(m[cls], { cls })));
  const cellsOf = (main, months = false) => [...byHome].filter(([v]) => v.endsWith('|') === main)
    .flatMap(([, rows]) => rows.flatMap((r) => [...CLASSES.map((cls) => r[cls] && Object.assign(r[cls], { cls })), ...(months ? monthCells(r) : [])]).filter(Boolean)); // groupsOf reads cls
  const homes = fares.homes;
  const estimate = (t) => {
    const long = t.tickets.filter((x) => homes.includes(x.from) || homes.includes(x.to));
    if (long.length !== 2 || long.some((x) => x.kind !== 'ow')) return t.total;
    const [out, back] = long;
    const rt = [out.to, back.from].flatMap((c) => fares.roundTrip(out.from, c, out.cabin, out.date)).filter((r) => r.ret === back.date);
    return rt.length ? t.total - out.price - back.price + Math.min(...rt.map((r) => r.price)) : t.total;
  };
  let chrome = null;
  let browser = null;
  if (search) {
    chrome = await openBrowserThread({ lean: true });
    browser = chrome.shoppingResults;
  }
  try {
    const t0 = Date.now();
    // Each class most promising first, taking turns: economy totals would otherwise always win.
    const byClass = CLASSES.map((c) => cellsOf(true).filter((t) => t.cls === c).sort((a, b) => estimate(a) - estimate(b)));
    const turns = byClass[0].flatMap((t, i) => [t, byClass[1][i]]).concat(byClass[1].slice(byClass[0].length)).filter(Boolean);
    // Trips through a Pacific stop first, up to PACIFIC_MULTI: their one-ticket fare (a stopover
    // fare) is the point of them, and they're rarely the cheapest by estimate.
    const pacific = turns.filter((t) => t.tickets.some((x) => isPacific(x.to))).slice(0, PACIFIC_MULTI);
    const main = [...pacific, ...turns.filter((t) => !pacific.includes(t))];
    const st = await applyMulti(dataDir, main, homes, browser, { budget: MULTI_BUDGET, until });
    await applyMulti(dataDir, [...cellsOf(false, true), ...cellsOf(true, true).filter((t) => !main.includes(t))], homes, null);
    for (const [view, rows] of byHome) {
      for (const t of rows.flatMap((r) => [r.hybrid, r.economy, ...monthCells(r)])) if (t) { t.tier = tierOf(alertConfig, t.cls, t.total); delete t.cls; }
      byHome.set(view, sortRows(rows));
    }
    return { ...st, ms: Date.now() - t0 };
  } finally {
    await chrome?.close();
  }
}

/** Per route directory: priced cells and their oldest and newest sightings. */
function freshness(dataDir) {
  const dir = path.join(dataDir, 'routes');
  if (!fs.existsSync(dir)) return [];
  const network = fs.existsSync(path.join(dataDir, 'state', 'network.json')) ? JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'network.json'), 'utf8')) : { pairs: {} };
  const staleAfter = staleAfterHours(config, network);
  const now = Date.now();
  return fs.readdirSync(dir).sort().map((route) => {
    const f = path.join(dir, route, 'current.json');
    const cells = fs.existsSync(f) ? Object.entries(JSON.parse(fs.readFileSync(f, 'utf8'))).filter(([, c]) => c.seen) : [];
    const seen = cells.map(([, c]) => c.seen).sort();
    // Cells past their cutoff (twice the graph's max age): loadFares drops them from the board.
    const expired = cells.filter(([key, c]) => now - Date.parse(c.seen) > staleAfter(route, Number(key.split('|')[1])) * 3600e3).length;
    return { route, cells: seen.length, oldest: seen[0] ?? null, newest: seen.at(-1) ?? null, expired };
  });
}

/** Views: "HOME|" is the dashboard's, "HOME|CITY" the via filter's for each city (a city every trip stays in needs none). */
function viewsOf(trips) {
  const main = trips.filter((t) => !t.via);
  const vias = [...new Set(trips.map((t) => t.via))].filter((c) => c && !main.every((t) => t.tickets.some((x) => x.to === c))).sort();
  return { vias, byHome: new Map(config.origins.flatMap((home) => ['', ...vias].map((via) => [`${home}|${via}`, rowsFor(home, trips, via)]))) };
}

async function main() {
  const dataDir = arg('data');
  if (!dataDir) throw new Error('--data <dir> is required');
  const t0 = Date.now();
  const warm = arg('warm') ? Number(arg('warm')) * 1000 : null;
  const deadline = warm ?? (arg('deadline') ? Number(arg('deadline')) * 1000 : Infinity);
  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const checkedFile = path.join(dataDir, 'state', 'checked.json');
  const checkedLog = Object.fromEntries(Object.entries(fs.existsSync(checkedFile) ? JSON.parse(fs.readFileSync(checkedFile, 'utf8')) : {})
    .filter(([, c]) => Date.parse(generatedAt) - Date.parse(c.at) < CHECKED_HOURS * 3600e3));
  // A listed price stands only if searched after the graph's price last changed (fares.js); an
  // entry without its search time (before 2026-11-03) can't show that and is dropped.
  const checked = () => new Map(Object.entries(checkedLog).filter(([, c]) => c.searched).map(([k, c]) => [k, { price: c.price, at: c.searched }]));
  const multi = multiCache(dataDir, Date.parse(generatedAt));
  rankOf = (t) => scoreOf(t) - multiSaving(multi, t, config.origins);
  // Phase timings: where a slow build spends its time, in the CI log as it runs.
  const lap = (what) => console.log(`${what}: ${Math.round((Date.now() - t0) / 1000)} s in, heap ${Math.round(process.memoryUsage().heapUsed / 2 ** 20)} MB`);
  const details0 = !process.argv.includes('--no-details');
  const searches = loadSearches(arg('search-cache'), Date.parse(generatedAt));
  // Booking-page prices: the last build's (state/booking.json) and the ones checked beside this
  // scrape (--booking-cache), applied to every search's rows (details.js useBookings).
  const bookingFile = path.join(dataDir, 'state', 'booking.json');
  const queueFile = arg('booking-queue'); // kept between runs in the Actions cache, not in git
  const bookings = loadBookings([bookingFile, arg('booking-cache')], Date.parse(generatedAt));
  useBookings(bookings);
  for (const [k, p] of searches.cache) applyBookings(bookings, k, await p);
  for (const [k, v] of searches.stale) applyBookings(bookings, k, v);
  console.log(`booking prices: ${bookings.size} under the age limit`);
  const homes = config.origins;
  const rowsOf = async () => { const m = new Map(searches.stale); for (const [k, p] of searches.cache) { const v = await p; if (Array.isArray(v)) m.set(k, v); } return (k) => m.get(k) ?? null; };
  // Beside the scrape: the last build's shown tickets (its trips files) on their booking pages,
  // while this run plans. In the build: this build's, after the checks.
  const warmBooking = warm && (async () => {
    // The last build's queue (its shown tickets, then every other ticket its checks priced), else
    // its shown tickets.
    let tickets = [];
    try { if (queueFile) tickets = JSON.parse(fs.readFileSync(queueFile, 'utf8')); } catch {}
    if (!tickets.length) tickets = homes.flatMap((h) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'derived', `trips-${h}.json`), 'utf8')).ticketTable ?? []; } catch { return []; } });
    const itins = bookingCandidates(tickets, await rowsOf(), bookings, homes);
    const b = await openBrowserThread({ lean: true });
    try {
      const s = await bookingPass(itins, (t) => b.bookingSellers(t), bookings, { until: Date.now() + BOOKING_WARM_MS, pages: BOOKING_PAGES.warm, inCabin });
      console.log(`booking pages beside the scrape: ${s.checked} of ${itins.length} checked, ${s.cheaper} cheaper than listed, ${s.none} with no seller in its cabin, ${s.failed} failed, ${s.left} left; ${Math.round(s.ms / 1000)} s`);
    } finally { await b.close(); }
    if (arg('booking-cache')) saveBookings(arg('booking-cache'), bookings);
  })().catch((e) => console.log(`booking pages beside the scrape: ${e.message}`));
  console.log(`search cache: ${searches.cache.size} under ${SEARCH_HOURS} h old, ${searches.stale.size} up to ${STALE_DAYS} days, ${[...searches.lands.values()].filter((d) => d > 0).length} flights landing a day or more on`);
  const now = Date.now();
  const load = () => ({ dataDir, now, checked: checked(), lands: searches.lands });
  let fares = loadFares(dataDir, config, load());
  searches.cache.changed = fares.changed;
  lap('fares loaded');
  let trips = await buildTripsThreaded(fares, load());
  lap(`${trips.length} trips planned`);
  let { vias, byHome } = viewsOf(trips);
  lap(`rows for ${vias.length} vias`);
  let details = null;
  if (details0) {
    // Searches whose page inlines no results are asked again in a real page (gflights/flights.js).
    const chrome = await openBrowserThread({ lean: true });
    const session = { cache: searches.cache, browser: (q, opts) => { details.browser++; return chrome.shoppingResults(q, opts); }, listed: new Map(), deadline: warm ?? deadline - DETAILS_RESERVE, pages: warm ? PAGES.warm : PAGES.build, warm: !!warm };
    details = { browser: 0, rounds: 0, searches: 0, failed: 0, late: 0, ms: 0 };
    try {
      for (;;) {
        const s = await verify(byHome, trips, session);
        details = { ...s, rounds: details.rounds + 1, browser: details.browser, searches: details.searches + s.searches, failed: details.failed + s.failed, late: details.late + s.late, ms: details.ms + s.ms };
        // Fares listed at another price than they were planned at: plan again with what's listed.
        const moved = [...session.listed].filter(([k, p]) => { const was = fareOf(fares, k); return was != null && Math.abs(p - was) > Math.max(2, was * 0.01); });
        for (const [k, price] of session.listed) checkedLog[k] = { price, at: generatedAt, searched: session.listed.at?.get(k) ?? generatedAt };
        session.listed.clear();
        session.listed.at?.clear();
        console.log(`details round ${details.rounds}: ${s.cells} cells, ${s.replaced} moved to another trip (connects, or cheaper as listed), ${s.unresolved} with none that connects, ${s.unknown} hidden with no flights checked; ${s.searches} searches${s.late ? ` (${s.late} skipped, out of time)` : ''}, ${s.none} flights not listed yet, ${s.stay} trips with a short Hoi An stay; ${moved.length} fares listed at a new price; ${s.ms}ms (checks ${Math.round(s.detailsMs / 1000)} s, event loop delay ${s.lag}, long-haul caps ${Math.round(s.fastMs / 1000)} s, past the search deadline ${Math.round(Math.max(0, Date.now() - session.deadline) / 1000)} s)`);
        if (warm || !moved.length || details.rounds >= ROUNDS || Date.now() > session.deadline) break;
        const done = [];
        for (const [k, r] of session.cache) { const v = await r; if (Array.isArray(v) && v.length) done.push([k, v]); }
        for (const [k, v] of searches.stale) if (!session.cache.has(k)) done.push([k, v]);
        searches.lands = landings(done); // this round's searches too
        fares = loadFares(dataDir, config, load());
        searches.cache.changed = fares.changed;
        trips = await buildTripsThreaded(fares, load());
        ({ vias, byHome } = viewsOf(trips));
        lap('planned again');
      }
      if (!warm) {
        const until = Math.min(Date.now() + BOOKING_BUILD_MS, deadline - MULTI_RESERVE - 60e3);
        const tickets = [...byHome].filter(([v]) => v.endsWith('|')).flatMap(([, rows]) => rows.flatMap((r) => CLASSES.flatMap((cls) => cellTrips(r, cls)).flatMap((t) => t.tickets)));
        const lookup = await rowsOf();
        const itins = bookingCandidates(tickets, lookup, bookings, homes);
        const s = await bookingPass(itins, (t) => chrome.bookingSellers(t), bookings, { until, pages: BOOKING_PAGES.build, inCabin });
        console.log(`booking pages: ${s.checked} of ${itins.length} checked, ${s.cheaper} cheaper than listed, ${s.none} with no seller in its cabin, ${s.failed} failed, ${s.left} left (used from the next build); ${Math.round(s.ms / 1000)} s`);
        // Beyond the board: every other ticket the checks priced (each cell's next-best trips, by
        // their listed prices), cheapest first, so a date the cache prices too high for the board
        // can still be found cheaper on its booking page. The next run's pass beside the scrape
        // works through it after the shown tickets.
        const shown = new Set(tickets);
        const others = [...new Set(trips.flatMap((t) => t.tickets))].filter((t) => !shown.has(t) && t.flights?.out?.legs?.length).sort((a, b) => a.price - b.price);
        const queue = bookingCandidates([...tickets, ...others], lookup, new Map(), homes).slice(0, QUEUE_MAX).map(slim);
        if (queueFile) fs.writeFileSync(queueFile, JSON.stringify(queue));
        console.log(`booking queue: ${queue.length} itineraries (${tickets.length} shown tickets, ${others.length} others the checks priced)`);
      }
    } finally {
      await chrome.close();
    }
    const t = searches.cache.tally ?? {};
    const why = `${t.far ?? 0} past the inline horizon (straight to a browser), ${t.empty ?? 0} pages with none inlined, ${t.window ?? 0} searched again after the connection (connected ${t.windowHit ?? 0} of ${t.windowTry ?? 0} trips' misses), ${t.full ?? 0} full lists, ${t.pages ?? 0} browser pages, ${t.refreshed ?? 0} stale searches refreshed, ${t.returns ?? 0} round trips' returns searched with the outbound chosen, ${t.returnLate ?? 0} skipped out of time (${t.returnHit ?? 0} returns shown from one), ${t.blocked ?? 0} refused by Google`;
    const pct = (a, q) => (a.length ? `${(a.toSorted((x, y) => x - y)[Math.floor(q * (a.length - 1))] / 1000).toFixed(1)} s` : '-');
    console.log(`search mix: ${why}`);
    console.log(`search timing: ${t.plain ?? 0} plain fetches (median ${pct(t.plainMs ?? [], 0.5)}, 90% ${pct(t.plainMs ?? [], 0.9)}; ${t.plainEmpty ?? 0} with no results inlined, ${t.timeouts ?? 0} timed out, ${t.errors ?? 0} other errors), browser pages median ${pct(t.pageMs ?? [], 0.5)}, 90% ${pct(t.pageMs ?? [], 0.9)}`);
    const errorBy = Object.entries(t.errorBy ?? {}).sort((a, b) => b[1] - a[1]);
    if (errorBy.length) console.log(`plain search errors: ${errorBy.slice(0, 6).map(([w, n]) => `${n}× ${w}`).join('; ')}`);
    const emptyBy = Object.entries(t.emptyBy ?? {}).sort((a, b) => b[1] - a[1]);
    if (emptyBy.length) console.log(`search pages with none inlined, by route: ${emptyBy.slice(0, 12).map(([r, n]) => `${r} ${n}`).join(', ')} (${emptyBy.length} routes)`);
    await saveSearches(arg('search-cache'), searches, generatedAt);
    await warmBooking;
    if (warm) { console.log(`checks beside the scrape: ${details.searches} searches (${details.browser} in a browser, ${details.failed} failed, ${details.late} left)`); return; }
    fs.mkdirSync(path.dirname(checkedFile), { recursive: true });
    fs.writeFileSync(checkedFile, JSON.stringify(checkedLog));
    saveBookings(bookingFile, bookings);
    console.log(`details: ${details.searches} searches (${details.browser} in a browser, ${details.failed} failed, ${details.late} skipped out of time${details.error ? `, e.g. ${details.error}` : ''}) over ${details.rounds} rounds`);
  } else {
    for (const rows of byHome.values()) for (const r of rows) { delete r.cands; delete r.top; delete r.city; }
  }
  const dayAgo = valuesAt(dataDir, new Date(Date.parse(generatedAt) - 864e5).toISOString().replace(/\.\d+Z$/, 'Z'));
  const cells = [];
  // Starts no search within MULTI_STOP of the deadline (one in flight runs up to 60 s; the rest of
  // the build ~1 min): 2026-11-12 02:05 to 16:05, from 14 min on, it ran the build ~7 min past it and
  // every job into its limit, the alerts and the queue's save never run.
  const m = await multiPass(dataDir, byHome, fares, !process.argv.includes('--no-details') && Date.now() < deadline - MULTI_RESERVE, deadline - MULTI_STOP);
  console.log(`multi-city: ${m.searched} searched (${m.failed} failed), ${m.proofs ?? 0} searched again with the trip's flights chosen, ${m.merged} trips on one ticket (${m.self ?? 0} self-transfers joined); ${m.ms}ms`);
  if (details) details.multi = m;
  const unlisted = dropUnlisted(byHome);
  console.log(`priced as listed: ${unlisted.dropped} cells hidden with a price their flights weren't listed at (${Object.entries(unlisted.why).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${w}`).join(', ') || 'none'})`);
  if (details) details.unlisted = unlisted;
  // Stay ranges on every shown trip; lowest-ever marks.
  for (const rows of byHome.values()) {
    for (const r of rows) {
      for (const trip of CLASSES.flatMap((cls) => cellTrips(r, cls))) {
        // A ticket priced on its booking page (bookings.js): who sells it, and that page.
        for (const t of trip.tickets) {
          const row = t.flights?.back?.seller ? t.flights.back : t.flights?.out;
          if (row?.seller && row.price === t.price) { t.seller = row.seller; t.bookingUrl = bookingUrl(t); }
        }
        const flex = flexOf(trip, fares);
        if (flex?.length) trip.flex = flex;
      }
    }
  }
  lap('stay ranges');
  const views = (main) => Object.fromEntries([...byHome].filter(([v]) => v.endsWith('|') === main).map(([v, rows]) => [v, rows]));
  // Via views first: every view is marked against the lows before this build, then the main ones record.
  for (const [v, rows] of Object.entries(views(false))) markLows(dataDir, { [v.split('|')[0]]: rows }, generatedAt, { record: false });
  markLows(dataDir, Object.fromEntries(Object.entries(views(true)).map(([v, rows]) => [v.slice(0, -1), rows])), generatedAt);
  fs.rmSync(path.join(dataDir, 'derived', 'via'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, 'derived', 'via'), { recursive: true });
  for (const [view, rows] of byHome) {
    const [home, via] = view.split('|');
    if (via) {
      fs.writeFileSync(path.join(dataDir, 'derived', 'via', `trips-${home}-${via}.json`), packJson({ generatedAt, home, via, rows })); // listed in vias, so even when empty
      continue;
    }
    for (const r of rows) {
      for (const cls of CLASSES) {
        if (!r[cls]) continue;
        const cell = { home, cls, in: r.in, out: r.out, set: r.set, total: r[cls].total };
        cells.push(cell);
        const was = dayAgo.get(keyOf(cell));
        if (was != null) r[cls].was = was;
      }
    }
    fs.mkdirSync(path.join(dataDir, 'derived'), { recursive: true });
    // The filters' cells to their own file, loaded only when a filter is used.
    const filters = {};
    for (const r of rows) {
      const take = (t) => { const f = t?.fast; if (t) delete t.fast; return f; };
      const fast = { ...Object.fromEntries(CLASSES.map((cls) => [cls, take(r[cls])])), months: Object.fromEntries(Object.entries(r.months).map(([m, c]) => [m, Object.fromEntries(CLASSES.map((cls) => [cls, take(c[cls])]))])) };
      filters[rowId(r)] = { bands: r.bands ?? {}, fast };
      delete r.bands;
    }
    // Over GitHub's file limit the whole push fails: the filters go without (the page filters the
    // trips' own cells) rather than the build.
    const filtersJson = packJson({ generatedAt, home, caps: CAPS, rows: filters });
    const filtersFile = path.join(dataDir, 'derived', `filters-${home}.json`);
    if (filtersJson.length < MAX_FILE_BYTES) fs.writeFileSync(filtersFile, filtersJson);
    else { fs.rmSync(filtersFile, { force: true }); console.log(`filters-${home}.json: ${Math.round(filtersJson.length / 1e6)} MB, not written`); }
    fs.writeFileSync(path.join(dataDir, 'derived', `trips-${home}.json`), packJson({ generatedAt, home, vias, rows })); // compact: the phone loads it
    const top = rows[0]?.hybrid;
    console.log(`${home}: ${rows.length} rows${top ? `, best hybrid ${rowId(rows[0])} ${top.total} (${top.depart}…${top.ret})` : ''}`);
  }
  const changed = recordHistory(dataDir, generatedAt, cells);
  fs.writeFileSync(path.join(dataDir, 'derived', 'fares.json'), JSON.stringify({ ...bundleOf(fares), tiers: alertConfig.tiers }));
  fs.writeFileSync(path.join(dataDir, 'derived', 'status.json'), JSON.stringify({ generatedAt, details, frontier: fares.departures.at(-1) ?? null, routes: freshness(dataDir), alerts: alertConfig }));
  console.log(`built ${trips.length} trips, ${changed} cells changed, from ${fares.departures.length} departure days in ${Date.now() - t0}ms`);
}
main().catch((e) => { console.error(e); process.exit(1); });
