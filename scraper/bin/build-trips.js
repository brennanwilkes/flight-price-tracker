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
 *   derived/status.json   for the Health tab: this build's detail-check stats, each route's
 *                         freshness (cells, oldest and newest sighting), the alert thresholds
 *
 *   node scraper/bin/build-trips.js --data <dataDir> [--no-details] [--deadline <epoch seconds>] [--search-cache <file.json.gz>]
 *
 * --search-cache: a file keeping the flight checks' search results across builds, each reused for
 * SEARCH_HOURS (CI keeps it in the Actions cache): most cells are the same trips hour to hour.
 *
 * --deadline: when the build must be done (CI's job limit). Flight checks start no search after
 * DETAILS_RESERVE before it, the multi-city pass searches only with MULTI_RESERVE left.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const config = require('../config/sweep.json');
const { loadFares, bundleOf, fareOf } = require('../src/trips/fares');
const { buildTrips, similarCount, scoreOf, rowId, bandOf } = require('../../frontend/app/build.js');
const { CITIES, airportsOf } = require('../../frontend/app/cities.js');
const { recordHistory, valuesAt, keyOf } = require('../src/trips/history');
const { addDetails, capped, longestOf } = require('../src/trips/details');
const { openBrowser, shoppingResults } = require('../src/gflights/browser');
const alertConfig = require('../config/alerts.json');
const { tierOf } = require('../src/alerts/rules');
const { flexOf } = require('../../frontend/app/flex.js');
const { markLows, cellTrips } = require('../src/trips/lows');
const { applyMulti, multiCache, multiSaving } = require('../src/trips/multi');

const CLASSES = ['hybrid', 'economy'];
const TRIES = 10;
const THROW_INS = 4; // rows per crossing and class besides the one with its cheapest
const MULTI_BUDGET = 80; // multi-city searches per build (trips/multi.js)
const ROUNDS = 3;
const CHECKED_HOURS = 24;
const DETAILS_RESERVE = 8 * 60e3; // multi-city ~4 min, a page still loading ≤ 4 min
const MULTI_RESERVE = 5 * 60e3;
// A day's flights and times hold for a day; their listed prices are trusted as long (CHECKED_HOURS)
// and the fares behind them are 2-48 h old already. Every shown cell needs ~6,200 searches, a build
// makes ~800: under SEARCH_HOURS = 3 they could never all be fresh at once.
const SEARCH_HOURS = 24;
// The board's long-haul filter (hours, loosest first): each dashboard cell's cheapest trip with
// every long-haul flight at most that long, re-picked from its checked candidates' searches.
const CAPS = [18, 16, 15, 14, 13, 12, 11, 10];

/**
 * Search results from earlier builds, under SEARCH_HOURS old: { cache: key → result, at: key → ISO
 * time, lands: landings of them }.
 */
function loadSearches(file, now) {
  const cache = new Map(), at = new Map(), rows = [];
  if (file && fs.existsSync(file)) {
    try {
      for (const [k, when, v] of JSON.parse(zlib.gunzipSync(fs.readFileSync(file)))) {
        if (now - Date.parse(when) < SEARCH_HOURS * 3600e3) { cache.set(k, Promise.resolve(v)); at.set(k, when); rows.push([k, v]); }
      }
    } catch (e) {
      console.log(`search cache unreadable, starting empty: ${e.message}`);
    }
  }
  return { cache, at, lands: landings(rows) };
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
    const [from, to] = [q.from, q.to].map((a) => cityOf.get(JSON.stringify(a)) ?? a);
    const days = Math.min(...opts.map((o) => (Date.parse(o.legs.at(-1).arrDate) - Date.parse(q.out)) / 864e5));
    const key = `${from}|${to}|${q.out}`;
    if (Number.isFinite(days) && !(out.get(key) <= days)) out.set(key, days);
  }
  return out;
}
/** This build's successful searches, with the time each was made. */
async function saveSearches(file, { cache, at }, now) {
  if (!file) return;
  const rows = [];
  for (const [k, p] of cache) {
    const v = await p;
    if (Array.isArray(v) && v.length) rows.push([k, at.get(k) ?? now, v]);
  }
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(rows)));
  console.log(`search cache: ${rows.length} kept`);
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
async function verify(byHome, trips, { cache, browser, listed, deadline }) {
  const t0 = Date.now();
  const st = { cells: 0, replaced: 0, unresolved: 0, unknown: 0, searches: 0, failed: 0, late: 0, none: 0, stay: 0 };
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
  // Rank by rank, each walked to the end before the next starts: a dashboard cell's later
  // candidates come before any via cell's first.
  for (let rank = 0; rank <= 9; rank++) {
    let pending = cells.filter((p) => p.rank === rank);
    while (pending.length) {
      const s = await addDetails(pending.map((p) => p.cand), cache, browser, listed, deadline);
      st.searches += s.searches;
      st.failed += s.failed;
      st.late += s.late;
      st.error ??= s.error;
      st.none += s.none;
      st.stay += s.stay;
      pending = pending.filter((p) => {
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
        p.put(p.best);
        if (!p.best) st[p.unknown ? 'unknown' : 'unresolved']++;
        else if (p.best !== p.first) st.replaced++;
        return false;
      });
    }
  }
  // The long-haul filter's cells, on the dashboard's (no searches: what the checks found).
  const t1 = Date.now();
  for (const p of cells) if (p.rank < 5 && p.best) await fastOf(p, cache);
  st.fastMs = Date.now() - t1;
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
async function fastOf(p, cache) {
  const homes = config.origins;
  const fast = {};
  let cur = p.best;
  for (const cap of CAPS) {
    if (longestOf(cur, homes) <= cap * 60) continue;
    let best = null;
    for (const c of p.checked ?? []) {
      const t = await capped(c, cache, cap * 60, homes);
      if (t && !(best && rankOf(best) <= rankOf(t))) best = t;
    }
    fast[cap] = best && { ...best, tier: tierOf(alertConfig, p.cls, best.total) };
    cur = best;
    if (!cur) break;
  }
  if (Object.keys(fast).length) p.best.fast = fast;
}

/**
 * Multi-city single tickets (trips/multi.js) for the shown cells: the main views' overall cells
 * searched, most promising first (an open jaw estimated at the cheaper return to either end, which
 * is about what airlines charge); the via views and the month cells take the cached prices only.
 * Re-tiers and re-sorts the rows.
 */
async function multiPass(dataDir, byHome, fares, search) {
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
    const b = await openBrowser();
    chrome = b.browser;
    browser = (q, opts) => shoppingResults(b.ctx, q, opts);
  }
  try {
    const t0 = Date.now();
    // Each class most promising first, taking turns: economy totals would otherwise always win.
    const byClass = CLASSES.map((c) => cellsOf(true).filter((t) => t.cls === c).sort((a, b) => estimate(a) - estimate(b)));
    const main = byClass[0].flatMap((t, i) => [t, byClass[1][i]]).concat(byClass[1].slice(byClass[0].length)).filter(Boolean);
    const st = await applyMulti(dataDir, main, homes, browser, { budget: MULTI_BUDGET });
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
  return fs.readdirSync(dir).sort().map((route) => {
    const f = path.join(dir, route, 'current.json');
    const seen = fs.existsSync(f) ? Object.values(JSON.parse(fs.readFileSync(f, 'utf8'))).map((c) => c.seen).filter(Boolean).sort() : [];
    return { route, cells: seen.length, oldest: seen[0] ?? null, newest: seen.at(-1) ?? null };
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
  const deadline = arg('deadline') ? Number(arg('deadline')) * 1000 : Infinity;
  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const checkedFile = path.join(dataDir, 'state', 'checked.json');
  const checkedLog = Object.fromEntries(Object.entries(fs.existsSync(checkedFile) ? JSON.parse(fs.readFileSync(checkedFile, 'utf8')) : {})
    .filter(([, c]) => Date.parse(generatedAt) - Date.parse(c.at) < CHECKED_HOURS * 3600e3));
  const checked = () => new Map(Object.entries(checkedLog).map(([k, c]) => [k, c.price]));
  const multi = multiCache(dataDir, Date.parse(generatedAt));
  rankOf = (t) => scoreOf(t) - multiSaving(multi, t, config.origins);
  // Phase timings: where a slow build spends its time, in the CI log as it runs.
  const lap = (what) => console.log(`${what}: ${Math.round((Date.now() - t0) / 1000)} s in, heap ${Math.round(process.memoryUsage().heapUsed / 2 ** 20)} MB`);
  const details0 = !process.argv.includes('--no-details');
  const searches = loadSearches(arg('search-cache'), Date.parse(generatedAt));
  console.log(`search cache: ${searches.cache.size} under ${SEARCH_HOURS} h old, ${[...searches.lands.values()].filter((d) => d > 0).length} flights landing a day or more on`);
  let fares = loadFares(dataDir, config, { checked: checked(), lands: searches.lands });
  lap('fares loaded');
  let trips = buildTrips(fares);
  lap(`${trips.length} trips planned`);
  let { vias, byHome } = viewsOf(trips);
  lap(`rows for ${vias.length} vias`);
  let details = null;
  if (details0) {
    // Searches whose page inlines no results are asked again in a real page (gflights/flights.js).
    const { browser: chrome, ctx } = await openBrowser();
    const session = { cache: searches.cache, browser: (q, opts) => { details.browser++; return shoppingResults(ctx, q, opts); }, listed: new Map(), deadline: deadline - DETAILS_RESERVE };
    details = { browser: 0, rounds: 0, searches: 0, failed: 0, late: 0, ms: 0 };
    try {
      for (;;) {
        const s = await verify(byHome, trips, session);
        details = { ...s, rounds: details.rounds + 1, browser: details.browser, searches: details.searches + s.searches, failed: details.failed + s.failed, late: details.late + s.late, ms: details.ms + s.ms };
        // Fares listed at another price than they were planned at: plan again with what's listed.
        const moved = [...session.listed].filter(([k, p]) => { const was = fareOf(fares, k); return was != null && Math.abs(p - was) > Math.max(2, was * 0.01); });
        for (const [k, price] of session.listed) checkedLog[k] = { price, at: generatedAt };
        session.listed.clear();
        console.log(`details round ${details.rounds}: ${s.cells} cells, ${s.replaced} moved to another trip (connects, or cheaper as listed), ${s.unresolved} with none that connects, ${s.unknown} hidden with no flights checked; ${s.searches} searches${s.late ? ` (${s.late} skipped, out of time)` : ''}, ${s.none} flights not listed yet, ${s.stay} trips with a short Hoi An stay; ${moved.length} fares listed at a new price; ${s.ms}ms`);
        if (!moved.length || details.rounds >= ROUNDS || Date.now() > session.deadline) break;
        const done = [];
        for (const [k, r] of session.cache) { const v = await r; if (Array.isArray(v) && v.length) done.push([k, v]); }
        searches.lands = landings(done); // this round's searches too
        fares = loadFares(dataDir, config, { checked: checked(), lands: searches.lands });
        trips = buildTrips(fares);
        ({ vias, byHome } = viewsOf(trips));
        lap('planned again');
      }
    } finally {
      await chrome.close();
    }
    await saveSearches(arg('search-cache'), searches, generatedAt);
    fs.mkdirSync(path.dirname(checkedFile), { recursive: true });
    fs.writeFileSync(checkedFile, JSON.stringify(checkedLog));
    console.log(`details: ${details.searches} searches (${details.browser} in a browser, ${details.failed} failed, ${details.late} skipped out of time${details.error ? `, e.g. ${details.error}` : ''}) over ${details.rounds} rounds`);
  } else {
    for (const rows of byHome.values()) for (const r of rows) { delete r.cands; delete r.top; delete r.city; }
  }
  const dayAgo = valuesAt(dataDir, new Date(Date.parse(generatedAt) - 864e5).toISOString().replace(/\.\d+Z$/, 'Z'));
  const cells = [];
  const m = await multiPass(dataDir, byHome, fares, !process.argv.includes('--no-details') && Date.now() < deadline - MULTI_RESERVE);
  console.log(`multi-city: ${m.searched} searched (${m.failed} failed), ${m.merged} trips cheaper as one ticket; ${m.ms}ms`);
  if (details) details.multi = m;
  // Stay ranges on every shown trip; lowest-ever marks.
  for (const rows of byHome.values()) {
    for (const r of rows) {
      for (const trip of CLASSES.flatMap((cls) => cellTrips(r, cls))) {
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
      fs.writeFileSync(path.join(dataDir, 'derived', 'via', `trips-${home}-${via}.json`), JSON.stringify({ generatedAt, home, via, rows })); // listed in vias, so even when empty
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
    fs.writeFileSync(path.join(dataDir, 'derived', `filters-${home}.json`), JSON.stringify({ generatedAt, home, caps: CAPS, rows: filters }));
    fs.writeFileSync(path.join(dataDir, 'derived', `trips-${home}.json`), JSON.stringify({ generatedAt, home, vias, rows })); // compact: the phone loads it
    const top = rows[0]?.hybrid;
    console.log(`${home}: ${rows.length} rows${top ? `, best hybrid ${rowId(rows[0])} ${top.total} (${top.depart}…${top.ret})` : ''}`);
  }
  const changed = recordHistory(dataDir, generatedAt, cells);
  fs.writeFileSync(path.join(dataDir, 'derived', 'fares.json'), JSON.stringify({ ...bundleOf(fares), tiers: alertConfig.tiers }));
  fs.writeFileSync(path.join(dataDir, 'derived', 'status.json'), JSON.stringify({ generatedAt, details, routes: freshness(dataDir), alerts: alertConfig }));
  console.log(`built ${trips.length} trips, ${changed} cells changed, from ${fares.departures.length} departure days in ${Date.now() - t0}ms`);
}
main().catch((e) => { console.error(e); process.exit(1); });
