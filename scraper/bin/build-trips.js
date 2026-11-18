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
const { loadFares, bundleOf, fareOf, fareKey } = require('../src/trips/fares');
const { graphTickets, searchTies, TRIED_HOURS } = require('../src/trips/ties');
const { similarCount, scoreOf, rowId, bandOf } = require('../../frontend/app/build.js');
const { CITIES, airportsOf, isPacific } = require('../../frontend/app/cities.js');
const { recordHistory, valuesAt, keyOf } = require('../src/trips/history');
const { viewOf, addDetails, returnsDone, returnsFor, returnsReady, searched, capped, longestOf, listedOnly, unlistedWhy, useBookings } = require('../src/trips/details');
const { loadBookings, saveBookings, applyBookings, stripBookings, bookingCandidates, bookingPass, passLine, listedOf, keyOf: bookingKey, BOOKING_HOURS } = require('../src/trips/bookings');
const { inCabin, bookingUrl, canary } = require('../src/gflights/booking');
const { openBrowserThread } = require('../src/gflights/browser-thread');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const alertConfig = require('../config/alerts.json');
const { tierOf } = require('../src/alerts/rules');
const { flexOf } = require('../../frontend/app/flex.js');
const { packJson } = require('../../frontend/app/pack.js');
const { markLows, cellTrips } = require('../src/trips/lows');
const { turnover } = require('../src/trips/turnover');
const { applyMulti, multiCache, multiSaving } = require('../src/trips/multi');
const { buildTripsThreaded } = require('../src/trips/threads');

const CLASSES = ['hybrid', 'economy'];
const TRIES = 10;
const STAND_TRIES = 2 * TRIES; // candidates walked for a proven trip to show while the best's return is searched (verify)
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
// `min`: the booking pass's cabin check goes by flight length (gflights/booking.js inCabin).
const slimLegs = (f) => f && { legs: f.legs.map(({ code, from, to, depDate, min }) => ({ code, from, to, depDate, min })) };
// `listed`: what Google listed it at, before booking prices (bookings.js listedOf): a page is judged against that.
const slim = (t) => ({ kind: t.kind, from: t.from, to: t.to, date: t.date, ret: t.ret, cabin: t.cabin, price: t.price, listed: listedOf(t), ...(t.alt ? { alt: 1 } : {}), flights: { out: slimLegs(t.flights.out), back: slimLegs(t.flights.back) } });
// A day's flights and times hold for a day; their listed prices are trusted as long (CHECKED_HOURS)
// and the fares behind them are 2-48 h old already. Every shown cell needs ~6,200 searches, a build
// makes ~800: under SEARCH_HOURS = 3 they could never all be fresh at once.
const SEARCH_HOURS = 24;
// Searches not touching the first home (YYJ's long hauls, the hops): fresh this long (Brennan, Nov
// 17: they matter less than YVR's long hauls; the search runner makes ~670 a run, its cap).
const SLOW_SEARCH_HOURS = 48;
const searchHours = (k) => {
  try { const q = JSON.parse(k.replace(/^full /, '')); return [q.from, q.to].flat().includes(config.origins[0]) ? SEARCH_HOURS : SLOW_SEARCH_HOURS; } catch { return SEARCH_HOURS; }
};
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
const SEARCH_QUEUE_MAX = 8000; // the search runner's queue: more than a run of it can do
// How far into its queue the search runner gets in a run (630-905, 12:05-11:05 am Vancouver Nov 14),
// with room: the builds leave these to it. Doubled Nov 16: the runner skips what its last run
// searched (the queue's head, written beside that run) and works the ~800 behind them.
const RUNNER_REACH = 2000;

/**
 * Search results from earlier builds, under SEARCH_HOURS old: { cache: key → result, at: key → ISO
 * time, lands: landings of them }.
 */
function loadSearches(file, now, extraFile = null) {
  const cache = new Map(), at = new Map(), stale = new Map(), rows = [];
  // The search cache, then the search runner's (--search-extra, bin/search-runner.js): the newer row wins.
  const newest = new Map();
  let extra = 0, newer = 0, extraTo = ''; // extraTo: the runner's newest row read here
  for (const [f, isExtra] of [[file, false], [extraFile, true]]) {
    if (!f || !fs.existsSync(f)) continue;
    try {
      for (const [k, when, v] of readRows(zlib.gunzipSync(fs.readFileSync(f)))) {
        const had = newest.get(k);
        if (isExtra) { extra++; if (!had || had[0] < when) newer++; if (when > extraTo) extraTo = when; }
        if (!had || had[0] < when) newest.set(k, [when, v]);
      }
    } catch (e) {
      console.log(`search cache ${path.basename(f)} unreadable${isExtra ? '' : ', starting empty'}: ${e.message}`);
    }
  }
  for (const [k, [when, v]] of newest) {
    const age = now - Date.parse(when);
    if (age >= STALE_DAYS * 864e5) continue;
    at.set(k, when);
    rows.push([k, v]);
    if (age < searchHours(k) * 3600e3) cache.set(k, Promise.resolve(v));
    else stale.set(k, v);
  }
  if (extraFile) console.log(`search runner's searches: ${extra} rows, ${newer} newer than the cache's`);
  cache.at = at;
  cache.stale = stale;
  return { cache, at, stale, lands: landings(rows), extraTo };
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
/**
 * Searches under SEARCH_HOURS old this build never looked up, by why: the cache held 20,644 fresh
 * at 2:05 pm Vancouver Nov 14 while the build used 7,576 of them. Kinds: a full list (`full `),
 * a window (`after`), a round trip's returns with an outbound chosen (`selected`), else plain.
 * Each unused one is matched to what the build did use: the same search's other form (its plain
 * or full list), the same trip with another outbound chosen, the same route and cabin on other
 * dates, or nothing on that route.
 */
function searchWaste(at, used, now) {
  const base = (k) => k.replace(/^full /, '');
  const strip = (q) => { const { selected, after, ...rest } = q; return rest; };
  const usedBase = new Set(), usedTrip = new Set(), usedRoute = new Set();
  for (const k of used.keys()) {
    const q = JSON.parse(base(k));
    usedBase.add(base(k));
    usedTrip.add(JSON.stringify(strip(q)));
    usedRoute.add(JSON.stringify([q.from, q.to, q.cabin, !!q.ret, !!q.selected]));
  }
  const kinds = {};
  let fresh = 0, unused = 0;
  for (const [k, when] of at) {
    if (now - Date.parse(when) >= searchHours(k) * 3600e3) continue;
    fresh++;
    if (used.has(k)) continue;
    unused++;
    const q = JSON.parse(base(k));
    const kind = k.startsWith('full ') ? 'full' : q.after ? 'window' : q.selected ? 'return' : 'plain';
    const why = usedBase.has(base(k)) && !q.selected && !q.after ? 'other form used'
      : usedTrip.has(JSON.stringify(strip(q))) ? (q.selected ? 'trip used, other outbound' : 'search used, no window')
        : usedRoute.has(JSON.stringify([q.from, q.to, q.cabin, !!q.ret, !!q.selected])) ? 'route used, other dates' : 'route unused';
    const m = (kinds[kind] ??= {});
    m[why] = (m[why] ?? 0) + 1;
  }
  const parts = Object.entries(kinds).map(([kind, m]) => `${kind} ${Object.values(m).reduce((a, b) => a + b, 0)} (${Object.entries(m).sort((a, b) => b[1] - a[1]).map(([w, c]) => `${w} ${c}`).join(', ')})`);
  return `search waste: ${unused} of ${fresh} searches under ${SEARCH_HOURS} h old not looked up this build: ${parts.join('; ')}`;
}

/**
 * Hour to hour: of the last build's lookups, how many this build looked up again; of the search
 * runner's queue head (what it searched this hour), how many this build looked up.
 */
/**
 * The search backlog as a flow: `last` the last build's queue ({ all, head, used, at }), `wanted`
 * this build's (left out of time). Keyed by each search's first key.
 */
function backlogFlow(last, wanted, { used, at, has, now }) {
  const tally = (o) => Object.entries(o).filter(([, n]) => n).map(([w, n]) => `${n} ${w}`).join(', ') || 'none';
  const k0 = (w) => w.keys[0];
  const nowKeys = new Set(wanted.map(k0));
  const headKeys = new Set((last.head ?? []).map(k0));
  const lastKeys = new Set(last.all.map(k0));
  const lastUsed = new Set(last.used ?? []);
  const lastAt = last.at ? Date.parse(last.at) : null;
  const left = {}; const stayed = {}; const joined = {};
  const add = (o, w) => { o[w] = (o[w] ?? 0) + 1; };
  for (const w of last.all) {
    const k = k0(w);
    // The runner works the last build's queue head while this build runs (its rows reach the next
    // build): staying in it means being searched now, not missed.
    const head = headKeys.has(k) ? "in the runner's head (its rows next build)" : "past the runner's head";
    if (nowKeys.has(k)) { add(stayed, head); continue; }
    if (!used.has(k)) add(left, 'no longer looked up');
    else if (has(k)) add(left, `searched since (${head})`);
    else add(left, 'other (fresh keys, not its first)');
  }
  for (const w of wanted) {
    const k = k0(w);
    if (lastKeys.has(k)) continue;
    const hours = searchHours(k);
    const cls = hours > SEARCH_HOURS ? `${hours} h (YYJ, hops)` : `${hours} h (YVR)`;
    if (!lastUsed.has(k)) { add(joined, w.had ? 'new lookup, searched before (stale)' : 'new lookup, never searched'); continue; }
    const when = at.get(k);
    // Fresh at the last build, past its hours now: aged out. Searched after the last build and
    // stale already can't be; stale then and not queued (it was searched in-build or left out).
    if (when && lastAt && now - Date.parse(when) >= hours * 3600e3 && lastAt - Date.parse(when) < hours * 3600e3) add(joined, `aged out, ${cls}`);
    else add(joined, `looked up last build too, not in its queue (${cls})`);
  }
  const hit = [...headKeys].filter((k) => has(k)).length;
  return `search backlog flow: ${lastKeys.size} → ${nowKeys.size}; left ${tally(left)}; stayed ${tally(stayed)}; joined ${tally(joined)}; the runner's head ${headKeys.size}, ${hit} of it fresh now`;
}

function searchChurn({ head, used: lastUsed }, used, { fareKeys = new Map(), expired = new Set(), usedTier = new Map() } = {}) {
  const parts = [];
  // Is the turnover a 24 h loop? A date lists above its graph price, the plan leaves it, its listed
  // price runs out at CHECKED_HOURS, the graph's is back and the date is walked again.
  if (lastUsed) {
    const last = new Set(lastUsed);
    let n = 0, all = 0;
    for (const k of used.keys()) {
      if (k.startsWith('full ') || !expired.has(fareKeys.get(k))) continue;
      all++;
      if (!last.has(k)) n++;
    }
    parts.push(`${expired.size} fares' listed prices ran out at ${CHECKED_HOURS} h since the last build: ${all} of them looked up, ${n} of those new lookups`);
  }
  if (lastUsed) {
    const again = lastUsed.filter((k) => used.has(k)).length;
    parts.push(`${again} of the last build's ${lastUsed.length} lookups looked up again, ${used.size - again} new`);
    // The new ones: kind, fresh/stale/never searched at lookup, and how far out they leave.
    const last = new Set(lastUsed);
    const by = {};
    const now = Date.now();
    for (const [k, state] of used) {
      if (last.has(k)) continue;
      const q = JSON.parse(k.replace(/^full /, ''));
      const kind = k.startsWith('full ') ? 'full' : q.after ? 'window' : q.selected ? 'return' : 'plain';
      const days = (Date.parse(q.out) - now) / 864e5;
      const out = days < 60 ? '<60 d' : days < 180 ? '60-180 d' : days < 300 ? '180-300 d' : '300+ d';
      const view = `for ${['the board', 'a via view', 'a long-haul cap'][usedTier.get(k) ?? 2]}`;
      for (const label of [`${kind} ${state}`, out, view]) by[label] = (by[label] ?? 0) + 1;
    }
    parts.push(`new by kind: ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(', ')}`);
  }
  const looked = head.filter((s) => s.keys.some((k) => used.has(k))).length;
  parts.push(`${looked} of the search runner's ${head.length} queue head looked up`);
  return `search churn: ${parts.join('; ')}`;
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
  // Where the hidden ones are: the board or a via view; an overall, month or trip-length cell, or
  // a long-haul filter's trip (the count was read as "board cells" and covers every view).
  const where = {};
  // ids: each hidden cell (view, row, holder, class, cap) → its `where`, to tell from build to
  // build how long a cell stays hidden (main: hidden cells by time hidden).
  const ids = new Map();
  const hid = (view, kind, id) => { const w = `${view.endsWith('|') ? 'board' : 'via'} ${kind}`; where[w] = (where[w] ?? 0) + 1; ids.set(id, w); };
  for (const [view, rows] of byHome) {
    for (const r of rows) {
      const months = Object.entries(r.months ?? {});
      const holders = [['overall', r], ...months, ...Object.entries(r.bands ?? {})];
      for (const [i, [name, h]] of holders.entries()) {
        for (const cls of CLASSES) {
          const c = h[cls];
          if (!c) continue;
          const id = `${view}#${r.in}-${r.out}#${r.set ?? ''}#${name}#${cls}`;
          if (!ok(c)) { h[cls] = null; hid(view, !i ? 'overall' : i <= months.length ? 'month' : 'length', id); continue; }
          for (const [k, t] of Object.entries(c.fast ?? {})) if (t && !ok(t)) { c.fast[k] = null; hid(view, 'long-haul cap', `${id}#${k}`); }
        }
      }
    }
  }
  return { dropped, why, where, ids };
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
  const st = { cells: 0, replaced: 0, unresolved: 0, unknown: 0, searches: 0, failed: 0, late: 0, none: 0, stay: 0, detailsMs: 0, standIn: 0, standInNone: 0, standInOver: [] };
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
    // The best whose returns are searched already: it can be shown this build.
    if (p.cand.connects && returnsReady(cache, p.cand) && !(p.shown && rankOf(p.shown) <= rankOf(p.cand))) p.shown = p.cand;
    let next = p.cands[++p.i];
    // conn is only known once checked: a candidate's rank can only rise from its builder rank.
    if (next && p.i < TRIES && !(p.best && rankOf(next) >= rankOf(p.best))) {
      p.cand = overall(next, trips, p.month);
      return true;
    }
    // The best's return isn't searched yet (a new outbound: the search takes a run or two, and
    // its cell was hidden meanwhile: 286-870 cells, Nov 16). The walk goes on for the best trip
    // that is proven already, to show until then: only candidates whose searches are all made
    // (no search added), up to STAND_TRIES.
    if (p.best && p.shown !== p.best) {
      for (; next && p.i < STAND_TRIES && !(p.shown && rankOf(next) >= rankOf(p.shown)); next = p.cands[++p.i]) {
        const cand = overall(next, trips, p.month);
        if (!searched(cache, cand)) continue;
        p.cand = cand;
        return true;
      }
      if (p.shown) { p.alt = p.shown; backs.push(returnsFor(cache, p.alt, p.rank * TRIES + TRIES - 0.5)); }
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
  // A cell whose best trip's return still isn't searched shows its best proven trip (step: p.alt)
  // until it is: priced as listed like any shown trip, and replaced once the cheaper one is proven.
  for (const p of cells) {
    if (!p.alt || listedOnly(p.best)) continue;
    if (!listedOnly(p.alt)) { st.standInNone++; continue; }
    p.alt.tier = tierOf(alertConfig, p.cls, p.alt.total);
    p.put(p.alt);
    st.standIn++;
    st.standInOver.push(p.alt.total / p.best.total - 1);
  }
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
  const checkedAll = Object.entries(fs.existsSync(checkedFile) ? JSON.parse(fs.readFileSync(checkedFile, 'utf8')) : {});
  const checkedLog = Object.fromEntries(checkedAll.filter(([, c]) => Date.parse(generatedAt) - Date.parse(c.at) < CHECKED_HOURS * 3600e3));
  // Telemetry (searchChurn): the fares whose listed price ran out since the last build.
  const expiredChecked = new Set(checkedAll.filter(([k]) => !(k in checkedLog)).map(([k]) => k));
  // Prices the booking runner proved on date pairs the board never checked (bin/booking-runner.js,
  // trips/ties.js), from its last run: taken where newer.
  try {
    for (const [k, c] of Object.entries(JSON.parse(fs.readFileSync(arg('booking-checked'), 'utf8')))) {
      if (c.price == null || Date.parse(generatedAt) - Date.parse(c.at) >= CHECKED_HOURS * 3600e3) continue;
      if (!checkedLog[k] || checkedLog[k].at < c.at) checkedLog[k] = c;
    }
  } catch {}
  // A listed price stands only if searched after the graph's price last changed (fares.js); an
  // entry without its search time (before 2026-11-03) can't show that and is dropped.
  const checked = () => new Map(Object.entries(checkedLog).filter(([, c]) => c.searched).map(([k, c]) => [k, { price: c.price, at: c.searched }]));
  const multi = multiCache(dataDir, Date.parse(generatedAt));
  rankOf = (t) => scoreOf(t) - multiSaving(multi, t, config.origins);
  // Phase timings: where a slow build spends its time, in the CI log as it runs.
  const lap = (what) => console.log(`${what}: ${Math.round((Date.now() - t0) / 1000)} s in, heap ${Math.round(process.memoryUsage().heapUsed / 2 ** 20)} MB`);
  const details0 = !process.argv.includes('--no-details');
  const searches = loadSearches(arg('search-cache'), Date.parse(generatedAt), arg('search-extra'));
  // The searches the search runner is making this hour (--runner-queue: the queue it works, the
  // last build's): not paged here too (details.js runnerKeys).
  if (arg('runner-queue')) {
    try {
      const last = JSON.parse(fs.readFileSync(arg('runner-queue'), 'utf8'));
      const head = (last.searches ?? []).slice(0, RUNNER_REACH);
      searches.cache.runnerKeys = new Set(head.flatMap((s) => s.keys));
      searches.last = { head, used: last.used ?? null, hidden: last.hidden ?? null, all: last.searches ?? [], at: last.at ?? null };
      console.log(`search runner's queue: ${head.length} searches left to it`);
    } catch (e) { console.log(`search runner's queue unread: ${e.message}`); }
  }
  // Booking-page prices: the last build's (state/booking.json) and the ones checked beside this
  // scrape (--booking-cache), applied to every search's rows (details.js useBookings).
  const bookingFile = path.join(dataDir, 'state', 'booking.json');
  const queueFile = arg('booking-queue'); // kept between runs in the Actions cache, not in git
  // --booking-extra: the booking runner's (sweep.yml job `booking`, bin/booking-runner.js), last run's.
  const bookings = loadBookings([bookingFile, arg('booking-cache'), arg('booking-extra')], Date.parse(generatedAt));
  console.log(`booking pages made twice within 2 h (the sweep's and the booking runner's, in the last 3 h): ${bookings.twice ?? 0}`);
  useBookings(bookings);
  for (const [k, p] of searches.cache) applyBookings(bookings, k, await p);
  for (const [k, v] of searches.stale) applyBookings(bookings, k, v);
  console.log(`booking prices: ${bookings.size} under the age limit`);
  const homes = config.origins;
  const rowsOf = async () => { const m = new Map(searches.stale); for (const [k, p] of searches.cache) { const v = await p; if (Array.isArray(v)) m.set(k, v); } return (k) => m.get(k) ?? null; };
  // Beside the scrape: the last build's shown tickets (its trips files) on their booking pages,
  // while this run plans. In the build: this build's, after the checks.
  const warmBooking = warm && (async () => {
    // The last build's queue (its tiers: the board's cells, then the filters'), else its board's tickets.
    let tiers = [];
    try { if (queueFile) { const q = JSON.parse(fs.readFileSync(queueFile, 'utf8')); tiers = Array.isArray(q) ? [q] : q.tiers ?? []; } } catch {}
    if (!tiers.flat().length) tiers = [homes.flatMap((h) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'derived', `trips-${h}.json`), 'utf8')).ticketTable ?? []; } catch { return []; } })];
    // With the booking runner on its own runner: this IP, short on booking pages from the start (it
    // scrapes and checks all hour; 10:05 pm Vancouver, 2026-11-12), searches flights for the date
    // pairs the board never checks instead (trips/ties.js), and the booking runner books them.
    if (process.env.BOOKING_RUNNER === '1' && arg('booking-ties')) {
      let tried = {};
      try { tried = JSON.parse(fs.readFileSync(arg('booking-checked'), 'utf8')); } catch {}
      const queued = new Set(tiers.flat().filter((t) => t.kind === 'rt').map(fareKey));
      // The last build's date pairs, booked by the runner during this run: not searched again. Without
      // this every other run searched the same pairs, and the runner found them all done (3:05 pm
      // Vancouver, 2026-11-13: "0 date pairs with flights queued").
      try { const q = JSON.parse(fs.readFileSync(queueFile, 'utf8')).ties ?? {}; for (const t of q.itins ?? []) queued.add(t.tie); for (const k of q.tried ?? []) queued.add(k); } catch {}
      // Its graph price lower than when last tried: due now, and first (a sale shows on the graph first).
      const dropped = (t) => { const g = tried[fareKey(t)]?.graph; return g != null && t.price < g - Math.max(5, g * 0.01); };
      // Tried: left TIE_HOURS when proven below the graph (BOOKING_HOURS: a discount moves), else TRIED_HOURS.
      const recent = (t) => { const c = tried[fareKey(t)]; return c && Date.now() - Date.parse(c.at) < (c.price == null ? TRIED_HOURS : BOOKING_HOURS) * 3600e3; };
      const list = graphTickets(dataDir, homes, { skip: (t) => queued.has(fareKey(t)) || (recent(t) && !dropped(t)) });
      const drops = list.filter(dropped);
      list.sort((a, b) => dropped(b) - dropped(a)); // stable: the graph's order otherwise
      console.log(`unchecked dates beside the scrape: ${drops.length} due early, their graph price lower than when tried${drops.length ? ` (e.g. ${drops[0].from}⇄${drops[0].to} ${drops[0].date}/${drops[0].ret} $${tried[fareKey(drops[0])].graph} → $${drops[0].price})` : ''}`);
      const b = await openBrowserThread({ lean: true });
      try {
        const t1 = Date.now();
        const r = await searchTies(list, { browser: (q, o) => b.shoppingResults(q, o), until: Date.now() + BOOKING_WARM_MS, bookings, homes });
        fs.writeFileSync(arg('booking-ties'), JSON.stringify({ at: generatedAt, itins: r.itins.map((t) => ({ ...slim(t), guess: true, tie: t.tie, graph: t.graph })), tried: r.tried }));
        console.log(`unchecked dates beside the scrape: ${list.length} business round trips on the graph not queued, tried in ${TRIED_HOURS} h or proven in ${BOOKING_HOURS} h; ${new Set(r.itins.map((t) => t.tie)).size} with flights both ways (${r.itins.length} itineraries for the booking runner), ${r.tried.length} without; ${Math.round((Date.now() - t1) / 1000)} s`);
      } finally { await b.close(); }
      return;
    }
    const itins = bookingCandidates(tiers, await rowsOf(), bookings, homes);
    const b = await openBrowserThread({ lean: true });
    try {
      // The canary (gflights/booking.js): which seller list this IP gets, before and after.
      const egress = await fetch('https://api.ipify.org').then((r) => r.text()).catch(() => '?');
      const view = await canary((t) => b.bookingSellers(t));
      console.log(`booking pages beside the scrape: exit IP ${egress}; canary ${view}`);
      // This IP also carries the scrape and the checks: short from the start at 10:05 pm (2026-11-12).
      // What it checks on the short list is kept SHORT_HOURS (bookings.js), then asked again.
      const s = await bookingPass(itins, (t) => b.bookingSellers(t), bookings, { until: Date.now() + BOOKING_WARM_MS, pages: BOOKING_PAGES.warm, inCabin, short: () => !view.startsWith('full'), primary: homes[0] });
      console.log(`booking pages beside the scrape: canary after ${await canary((t) => b.bookingSellers(t))}`);
      console.log(`booking pages beside the scrape: ${s.checked} of ${itins.length} checked, ${s.cheaper} cheaper than listed, ${s.none} with no seller in its cabin, ${s.failed} failed, ${s.left} left; ${Math.round(s.ms / 1000)} s`);
      console.log(`booking pages beside the scrape: ${passLine(s)}`);
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
    searches.cache.homes = config.origins; // telemetry (details.js returnMiss)
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
        const over = s.standInOver.toSorted((a, b) => a - b);
        console.log(`details round ${details.rounds}, cells whose best trip's return isn't searched yet: ${s.standIn} show their best proven trip meanwhile${over.length ? ` (over the best's unproven price: ${(100 * over[Math.floor(over.length / 2)]).toFixed(1)}% median, ${(100 * over.at(-1)).toFixed(1)}% most)` : ''}, ${s.standInNone} had one picked that didn't prove; the rest stay hidden (priced as listed: return not searched)`);
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
        // The board's own cells (overall and per month: the trips files), then the filters' (length
        // bands, single-flight: the filters files).
        const mainRows = [...byHome].filter(([v]) => v.endsWith('|')).flatMap(([, rows]) => rows);
        const board = mainRows.flatMap((r) => CLASSES.flatMap((cls) => [r[cls], ...Object.values(r.months ?? {}).map((m) => m[cls])]).filter(Boolean).flatMap((t) => t.tickets));
        const tickets = mainRows.flatMap((r) => CLASSES.flatMap((cls) => cellTrips(r, cls)).flatMap((t) => t.tickets));
        const lookup = await rowsOf();
        const itins = bookingCandidates([board, tickets], lookup, bookings, homes);
        const s = await bookingPass(itins, (t) => chrome.bookingSellers(t), bookings, { until, pages: BOOKING_PAGES.build, inCabin, primary: homes[0] });
        console.log(`booking pages: ${s.checked} of ${itins.length} checked, ${s.cheaper} cheaper than listed, ${s.none} with no seller in its cabin, ${s.failed} failed, ${s.left} left (used from the next build); ${Math.round(s.ms / 1000)} s`);
        console.log(`booking pages: ${passLine(s)}`);
        // Beyond the board: every other ticket the checks priced (each cell's next-best trips, by
        // their listed prices), cheapest first, so a date the cache prices too high for the board
        // can still be found cheaper on its booking page. The next run's pass beside the scrape
        // works through it after the shown tickets.
        const shown = new Set(tickets);
        const planned = [...new Set(trips.flatMap((t) => t.tickets))];
        const others = planned.filter((t) => !shown.has(t) && t.flights?.out?.legs?.length).sort((a, b) => a.price - b.price);
        // Telemetry (turnover.js goneWhy): each shown ticket's cell (its first, by the label below)
        // and that cell's total, carried in the queue's file; each cell's total and each planned
        // itinerary's price now. Why does a ticket leave the queue: dearer, no longer planned, or
        // its cell picked another trip at the same prices?
        const cellOf = new Map(); const cellTotal = new Map(); const priceNow = new Map();
        for (const [v, rows] of byHome) {
          if (!v.endsWith('|')) continue;
          for (const r of rows) {
            for (const cls of CLASSES) {
              const base = [['', r[cls]], ...Object.entries(r.months ?? {}).map(([m, x]) => [` ${m}`, x[cls]]), ...Object.entries(r.bands ?? {}).map(([b, x]) => [` band ${b}`, x[cls]])].filter(([, t]) => t);
              // Each long-haul cap's trip: `fast` keeps only the caps where the trip changes, so a cap
              // its trip keeps to takes the looser one's (else the cap's cell came and went with the
              // cell's pick); none under a cap: no cell for it or any tighter one.
              const capped = ([l, t]) => {
                const out = []; let cur = t;
                for (const cap of CAPS) {
                  if (t.fast && cap in t.fast) { if (!t.fast[cap]) break; cur = t.fast[cap]; }
                  out.push([`${l} fast ${cap}`, cur]);
                }
                return out;
              };
              for (const [l, t] of [...base, ...base.flatMap(capped)]) {
                const cell = `${v}${rowId(r)}|${cls}${l}`;
                cellTotal.set(cell, t.total);
                for (const x of t.tickets ?? []) { if (!x.flights?.out?.legs?.length) continue; const k = bookingKey(x); if (!cellOf.has(k)) cellOf.set(k, { cell, cellTotal: t.total }); }
              }
            }
          }
        }
        for (const t of planned) { if (!t.flights?.out?.legs?.length) continue; const k = bookingKey(t); if (!(priceNow.get(k) <= t.price)) priceNow.set(k, t.price); }
        const tiers = [bookingCandidates(board, lookup, new Map(), homes)];
        const boardKeys = new Map(tiers[0].map((t) => [bookingKey(t), null]));
        const filterAll = bookingCandidates([...tickets, ...others], lookup, boardKeys, homes);
        tiers.push(filterAll.slice(0, Math.max(0, QUEUE_MAX - tiers[0].length)));
        // Scaling (Nov 17): the window's departure days with fares grow ~1 a day until early April
        // 2027 (330-day horizon, window to Feb 29 2028). Demand per loaded day, and what the cap cuts.
        {
          const days = new Set(planned.filter((t) => t.date >= config.window.start && t.date <= config.window.end).map((t) => t.date)).size;
          const total = Math.round((Date.parse(config.window.end) - Date.parse(config.window.start)) / 864e5) + 1;
          const per = (n) => (days ? (n / days).toFixed(1) : '-');
          console.log(`scaling: ${days} of the window's ${total} departure days planned; board ${tiers[0].length} itineraries (${per(tiers[0].length)} a day), filters' ${filterAll.length} (${per(filterAll.length)} a day), ${Math.max(0, filterAll.length - tiers[1].length)} past the queue's cap of ${QUEUE_MAX} left out; ${planned.length} tickets planned (${per(planned.length)} a day); searches used ${searches.cache.used?.size ?? 0} (${per(searches.cache.used?.size ?? 0)} a day)`);
        }
        // With the date pairs searched beside the scrape (--booking-ties), for the booking runner.
        let ties = null;
        try { ties = JSON.parse(fs.readFileSync(arg('booking-ties'), 'utf8')); } catch {}
        // Telemetry: how much of the queue is new each build. The filters' "never checked" stayed at
        // ~7,000 through Nov 16 with ~830 of them checked a run: as many came in as were checked?
        try {
          const last = JSON.parse(fs.readFileSync(queueFile, 'utf8')).tiers ?? [];
          const turn = (l, was) => { const a = new Set(l.map(bookingKey)); const b = new Set((was ?? []).map(bookingKey)); const added = [...a].filter((k) => !b.has(k)); return `${added.length} of ${a.size} not in the last build's (${added.filter((k) => !bookings.has(k) && !bookings.prev?.has(k)).length} of them not checked in 48 h), ${[...b].filter((k) => !a.has(k)).length} of its ${b.size} gone`; };
          console.log(`booking queue turnover: board ${turn(tiers[0], last[0])}; filters' ${turn(tiers[1], last[1])}`);
        } catch (e) { console.log(`booking queue turnover: not worked out (${e.message})`); }
        // What the newcomers and the leavers are, how long tickets stay, how many come back (turnover.js).
        let seen = null;
        try {
          const q = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
          const r = turnover(tiers, q.tiers ?? [], q.seen, (k) => bookings.has(k) || !!bookings.prev?.has(k), Date.parse(generatedAt), undefined, { cellTotal, priceNow });
          seen = r.seen;
          for (const l of r.lines) console.log(l);
        } catch (e) { console.log(`booking queue turnover, by kind: not worked out (${e.message})`); }
        const slimCell = (t) => ({ ...slim(t), ...(t.alt ? {} : cellOf.get(bookingKey(t)) ?? {}) });
        if (queueFile) fs.writeFileSync(queueFile, JSON.stringify({ tiers: tiers.map((l) => l.map(slimCell)), ...(ties ? { ties } : {}), ...(seen ? { seen } : {}) }));
        const fresh = (l) => l.filter((t) => bookings.has(bookingKey(t))).length;
        console.log(`booking queue: ${tiers[0].length} board itineraries (${fresh(tiers[0])} with a booking price under ${BOOKING_HOURS} h), ${tiers[1].length} filters' (${fresh(tiers[1])}); ${tickets.length} shown tickets, ${others.length} others the checks priced`);
        // Of those due (none under BOOKING_HOURS), how many were checked before (bookings.prev, up to
        // 48 h) and are listed at the same price since: the rechecks a listed-price trigger would defer.
        const due = (l) => { const d = l.filter((t) => !bookings.has(bookingKey(t))); const p = d.filter((t) => bookings.prev?.has(bookingKey(t))); const same = p.filter((t) => Math.abs(listedOf(t) - bookings.prev.get(bookingKey(t)).listed) <= Math.max(5, listedOf(t) * 0.01)); return `${d.length} due, ${p.length} checked 12-48 h ago, ${same.length} of them listed at the same price`; };
        console.log(`booking queue due: board ${due(tiers[0])}; filters' ${due(tiers[1])}`);
        // Demand against throughput: the board's tickets are held 12 h, the filters' 12-24 h (12 when
        // discounted), so keeping all fresh takes about these many booking pages a run (hourly), plus
        // the tickets new to the queue (not checked in 48 h) as they come.
        const unseen = (l) => l.filter((t) => !bookings.has(bookingKey(t)) && !bookings.prev?.has(bookingKey(t))).length;
        console.log(`booking demand: board ${tiers[0].length} held 12 h takes ${Math.round(tiers[0].length / 12)} pages a run, ${unseen(tiers[0])} not checked in 48 h; filters' ${tiers[1].length} held 12-24 h take ${Math.round(tiers[1].length / 24)}-${Math.round(tiers[1].length / 12)} a run, ${unseen(tiers[1])} not checked in 48 h`);
      }
    } finally {
      await chrome.close();
    }
    const t = searches.cache.tally ?? {};
    const why = `${t.far ?? 0} past the inline horizon (straight to a browser), ${t.empty ?? 0} pages with none inlined, ${t.window ?? 0} searched again after the connection (connected ${t.windowHit ?? 0} of ${t.windowTry ?? 0} trips' misses), ${t.full ?? 0} full lists, ${t.pages ?? 0} browser pages (${t.runner ?? 0} left to the search runner), ${t.refreshed ?? 0} stale searches refreshed, ${t.outdated ?? 0} under ${SEARCH_HOURS} h old outdated by a graph price change (${t.outdatedUp ?? 0} up, ${t.outdatedDown ?? 0} down),${t.returns ?? 0} round trips' returns searched with the outbound chosen, ${t.returnLate ?? 0} skipped out of time (${t.returnHit ?? 0} returns shown from one), ${t.blocked ?? 0} refused by Google`;
    const pct = (a, q) => (a.length ? `${(a.toSorted((x, y) => x - y)[Math.floor(q * (a.length - 1))] / 1000).toFixed(1)} s` : '-');
    console.log(`search mix: ${why}`);
    console.log(`return searches for kept trips ended: ${Object.entries(t.returnEnd ?? {}).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(', ') || 'none'}`);
    console.log(`return searches never made, asked for kept trips: ${Object.entries(t.returnNew ?? {}).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(', ') || 'none'}`);
    console.log(`returns with none that fits: ${Object.entries(t.returnMiss ?? {}).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join('; ') || 'none'}`);
    for (const x of t.returnMissEx ?? []) console.log(`  e.g. ${x}`);
    console.log(`outbounds passed over (their returns hold none that fits): ${t.outDropped ?? 0}, ${t.outNone ?? 0} of them the trip's last (doesn't connect); in long-haul filter trips ${t.capOutDropped ?? 0}`);
    {
      // Why the board cells' never-searched searches weren't made in this build.
      const by = {};
      for (const w of searches.cache.wanted?.values() ?? []) if (!w.had && w.prio < 5 * TRIES) by[w.why] = (by[w.why] ?? 0) + 1;
      console.log(`board searches never made, left for the runner: ${Object.entries(by).map(([w, n]) => `${w} ${n}`).join(', ') || 'none'}`);
    }
    console.log(`search timing: ${t.plain ?? 0} plain fetches (median ${pct(t.plainMs ?? [], 0.5)}, 90% ${pct(t.plainMs ?? [], 0.9)}; in the fetch thread median ${pct(t.netMs ?? [], 0.5)}, 90% ${pct(t.netMs ?? [], 0.9)};${t.plainEmpty ?? 0} with no results inlined, ${t.timeouts ?? 0} timed out, ${t.errors ?? 0} other errors), browser pages median ${pct(t.pageMs ?? [], 0.5)}, 90% ${pct(t.pageMs ?? [], 0.9)}`);
    const errorBy = Object.entries(t.errorBy ?? {}).sort((a, b) => b[1] - a[1]);
    if (errorBy.length) console.log(`plain search errors: ${errorBy.slice(0, 6).map(([w, n]) => `${n}× ${w}`).join('; ')}`);
    const emptyBy = Object.entries(t.emptyBy ?? {}).sort((a, b) => b[1] - a[1]);
    if (emptyBy.length) console.log(`search pages with none inlined, by route: ${emptyBy.slice(0, 12).map(([r, n]) => `${r} ${n}`).join(', ')} (${emptyBy.length} routes)`);
    // Demand against throughput: each search used is held SEARCH_HOURS, so keeping every one fresh
    // takes used / SEARCH_HOURS searches an hour (a run). Ages at load say when the fresh ones
    // expire: the 18-24 h ones are next run's and the one after's.
    {
      const used = searches.cache.used ?? new Map();
      const n = { fresh: 0, stale: 0, none: 0 };
      const age = [0, 0, 0, 0]; // fresh at load, by age: 0-6, 6-12, 12-18, 18-24 h
      for (const [k, state] of used) {
        n[state]++;
        const when = searches.cache.at?.get(k);
        // In quarters of its own fresh hours (24 h YVR's, 48 h YYJ's and the hops'): by 6 h alone
        // every 48 h search past 18 h read "18-24 h" (9,164 of 16,146, Nov 18).
        if (state === 'fresh' && when) age[Math.min(3, Math.floor((Date.parse(generatedAt) - Date.parse(when)) / (searchHours(k) * 900e3)))]++;
      }
      console.log(`search demand: ${used.size} searches used, ${n.fresh} fresh at load (by age, in quarters of its fresh hours: ${age[0]} first, ${age[1]} second, ${age[2]} third, ${age[3]} last), ${n.stale} stale (served), ${n.none} never searched; kept fresh at ${SEARCH_HOURS} h (YVR's) and ${SLOW_SEARCH_HOURS} h (YYJ's, the hops') that takes ${Math.round([...used.keys()].reduce((s, k) => s + 1 / searchHours(k), 0))} a run (hourly), made this build ${(t.plain ?? 0) - (t.errors ?? 0) - (t.timeouts ?? 0)} plain + ${t.pages ?? 0} browser pages here, plus the search runner's (its newer rows above)`);
      {
        // The same by whose searches they are (the most important view that looked each up), with
        // the stale ones' ages: is the board's own demand fresh, and how old is what it's served?
        const tiers = [0, 1, 2].map(() => ({ fresh: 0, stale: 0, none: 0, age: [0, 0, 0] }));
        for (const [k, state] of used) {
          const v = tiers[searches.cache.usedTier?.get(k) ?? 2];
          v[state]++;
          const when = searches.at.get(k);
          if (state === 'stale' && when) v.age[Math.min(2, Math.floor(Math.log2(Math.max(1, (Date.parse(generatedAt) - Date.parse(when)) / 864e5))))]++;
        }
        console.log(`search demand by view: ${tiers.map((v, i) => `${['board', 'via only', 'long-haul caps only'][i]} ${v.fresh + v.stale + v.none} (${v.fresh} fresh, ${v.stale} stale: ${v.age[0]} 1-2 d, ${v.age[1]} 2-4 d, ${v.age[2]} 4-7 d; ${v.none} never searched)`).join('; ')}`);
      }
      try { console.log(searchWaste(searches.at, used, Date.parse(generatedAt))); } catch (e) { console.log(`search waste: not worked out (${e.message})`); }
      try { if (searches.last) console.log(searchChurn(searches.last, used, { fareKeys: searches.cache.fareKeys, expired: expiredChecked, usedTier: searches.cache.usedTier })); } catch (e) { console.log(`search churn: not worked out (${e.message})`); }
    }
    await saveSearches(arg('search-cache'), searches, generatedAt);
    // The browser searches left out of time, most wanted first, for the search runner (bin/search-runner.js).
    if (!warm && arg('search-queue')) {
      const wanted = [...(searches.cache.wanted?.values() ?? [])].filter((w) => !w.keys.every((k) => searches.cache.has(k)));
      // `view`: whose search it is, for the runner's tally (which views a run's pages reach).
      const VIEWS = ['board', 'via', 'long-haul cap'];
      const label = (w) => `${VIEWS[viewOf(w.prio)]} ${w.had ? (searchHours(w.keys[0]) > SEARCH_HOURS ? 'refresh (YYJ, hops)' : 'refresh') : 'never searched'}`;
      // Never searched first, any view's: its cell is hidden until it's made, where a refresh's is
      // shown from the stale list meanwhile (behind the board's ~4,900 refreshes at ~800 pages a
      // run, the via views' never-searched ones waited for good: 303 at 12:05 am Vancouver Nov 16).
      // Refreshes by view, the oldest day first (a list 7 days old is dropped: its cell hidden), then rank.
      const days = (w) => { const at = searches.at.get(w.keys[0]); return at ? Math.floor((Date.parse(generatedAt) - Date.parse(at)) / 864e5) : 0; };
      // Within a view, YVR's refreshes before YYJ's and the hops' (Brennan, Nov 17), but not one 5
      // days old or more: at STALE_DAYS (7) its list is dropped and its cell hidden.
      const slow = (w) => (searchHours(w.keys[0]) > SEARCH_HOURS && days(w) < STALE_DAYS - 2 ? 1 : 0);
      const order = new Map(wanted.map((w) => [w, w.had ? [1, viewOf(w.prio), slow(w), -days(w), w.prio] : [0, w.prio, 0, 0, 0]]));
      wanted.sort((a, b) => { const x = order.get(a), y = order.get(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3] || x[4] - y[4]; });
      const list = wanted.slice(0, SEARCH_QUEUE_MAX).map((w) => ({ q: w.q, keys: w.keys, had: w.had, view: label(w) }));
      {
        const by = {};
        for (const w of wanted) by[label(w)] = (by[label(w)] ?? 0) + 1;
        console.log(`search queue in order: ${Object.entries(by).map(([w, n]) => `${w} ${n}`).join(', ') || 'none'}`);
      }
      // Telemetry: the backlog as a flow against the last build's queue. What left it (searched
      // since, by the runner's share of its queue head or not; no longer looked up), what stayed (in
      // the runner's head and not made: rejected, failed or not reached; past its head), and what
      // joined (a search fresh last build that aged out, by its hours; a lookup new this build).
      try { if (searches.last?.all) console.log(backlogFlow(searches.last, wanted, { used: searches.cache.used ?? new Map(), at: searches.at, has: (k) => searches.cache.has(k), now: Date.parse(generatedAt) })); } catch (e) { console.log(`search backlog flow: not worked out (${e.message})`); }
      // used: this build's lookups, for the next build's churn line (searchChurn).
      fs.writeFileSync(arg('search-queue'), JSON.stringify({ at: generatedAt, extraTo: searches.extraTo || null, searches: list, used: [...(searches.cache.used?.keys() ?? [])] }));
      console.log(`search queue: ${list.length} browser searches for the search runner (${wanted.length} left out of time, ${wanted.filter((w) => w.had).length} of them served stale; never searched: ${wanted.filter((w) => !w.had && w.prio < 5 * TRIES).length} for board cells, ${wanted.filter((w) => !w.had && w.prio >= 5 * TRIES && w.prio < FAST_PRIO).length} for via cells, ${wanted.filter((w) => !w.had && w.prio >= FAST_PRIO).length} for long-haul caps)`);
    }
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
  console.log(`priced as listed: ${unlisted.dropped} cells hidden with a price their flights weren't listed at (${Object.entries(unlisted.why).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${w}`).join(', ') || 'none'}); where: ${Object.entries(unlisted.where).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(', ') || 'none'}`);
  // How long each hidden cell has been hidden: its first build hidden, carried in the search
  // queue's file from build to build. Hidden for a run or two is a search on its way (the runner's
  // results land ~2 runs on); hidden for many is stuck.
  if (!warm && arg('search-queue')) {
    try {
      const was = searches.last?.hidden ?? {};
      const now = Date.parse(generatedAt);
      const hidden = {};
      const by = {};
      const stuck = [];
      for (const [id, w] of unlisted.ids) {
        hidden[id] = was[id] ?? generatedAt;
        const h = (now - Date.parse(hidden[id])) / 3600e3;
        const age = h < 0.5 ? 'new' : h < 2.5 ? '1-2 h' : h < 6.5 ? '3-6 h' : h < 24.5 ? '7-24 h' : 'over a day';
        ((by[w] ??= {})[age] = (by[w][age] ?? 0) + 1);
        if (h >= 6.5) stuck.push([h, id]);
      }
      const shown = Object.keys(was).filter((id) => !unlisted.ids.has(id));
      const shownAfter = {};
      for (const id of shown) { const h = Math.round((now - Date.parse(was[id])) / 3600e3); const k = h <= 2 ? '1-2 h' : h <= 6 ? '3-6 h' : h <= 24 ? '7-24 h' : 'over a day'; shownAfter[k] = (shownAfter[k] ?? 0) + 1; }
      const fmt = (o) => Object.entries(o).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
      console.log(`hidden cells by time hidden: ${Object.entries(by).map(([w, o]) => `${w}: ${fmt(o)}`).join('; ') || 'none'}; no longer hidden since the last build ${shown.length} (after ${fmt(shownAfter)})`);
      for (const [h, id] of stuck.sort((a, b) => b[0] - a[0]).slice(0, 6)) console.log(`  hidden ${Math.round(h)} h: ${id}`);
      const file = JSON.parse(fs.readFileSync(arg('search-queue'), 'utf8'));
      fs.writeFileSync(arg('search-queue'), JSON.stringify({ ...file, hidden }));
    } catch (e) { console.log(`hidden cells by time hidden: not worked out (${e.message})`); }
  }
  delete unlisted.ids;
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
