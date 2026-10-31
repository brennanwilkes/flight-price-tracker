#!/usr/bin/env node
'use strict';
/* Build trips from the data branch's current fares and write what the dashboard reads:
 *
 *   derived/trips-<HOME>.json   { generatedAt, home, rows: [{ in, out, hybrid, economy, months: { "<YYYY-MM>": { hybrid, economy } } }] }
 *   derived/history/<YYYY-MM>.csv   (src/trips/history.js)
 *
 * One row per in/out city pair; each cell is that pair's cheapest trip (null when none), overall
 * and per departure month. Rows sorted by cheapest hybrid, then cheapest economy. Overall cells
 * carry `was`: the cell's total 24 h earlier, when known.
 *
 *   derived/via/trips-<HOME>-<CITY>.json   the same rows (no `was`), each cell the cheapest trip
 *                                           staying in CITY: the dashboard's via filter
 *
 * Every row's overall cells get the actual flights on each ticket
 * (src/trips/details.js; skipped with --no-details), and the listed prices: the price graph has
 * no times and can be stale, so a cell's cheapest trip may not connect or may cost more as listed.
 * Further candidates (any month, plus the builder's fallbacks) are checked while they could still
 * be cheaper, up to TRIES (verify), and rows re-sort on the checked totals.
 *
 *   derived/fares.json   the fares the trips were built from (fares.js bundleOf), for the page's
 *                        own builds: the via filter with several cities
 *
 *   derived/status.json   for the Health tab: this build's detail-check stats, each route's
 *                         freshness (cells, oldest and newest sighting), the alert thresholds
 *
 *   node scraper/bin/build-trips.js --data <dataDir> [--no-details]
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config/sweep.json');
const { loadFares, bundleOf } = require('../src/trips/fares');
const { buildTrips, similarCount } = require('../../frontend/app/build.js');
const { recordHistory, valuesAt, keyOf } = require('../src/trips/history');
const { addDetails } = require('../src/trips/details');
const { openBrowser, shoppingResults } = require('../src/gflights/browser');
const alertConfig = require('../config/alerts.json');
const { tierOf } = require('../src/alerts/rules');
const { flexOf } = require('../../frontend/app/flex.js');
const { markLows } = require('../src/trips/lows');
const { applyMulti } = require('../src/trips/multi');

const CLASSES = ['hybrid', 'economy'];
const TRIES = 10;
const MULTI_BUDGET = 80; // multi-city searches per build (trips/multi.js)

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

function rowsFor(home, trips, via = '') {
  const rows = new Map();
  for (const t of trips) {
    if (t.home !== home || t.via !== via) continue;
    const key = `${t.in}-${t.out}`;
    if (!rows.has(key)) rows.set(key, { in: t.in, out: t.out, hybrid: null, economy: null, months: {} });
    const row = rows.get(key);
    row.months[t.month] ??= { hybrid: null, economy: null };
    row.months[t.month][t.cls] = strip(t);
    row.cands ??= { hybrid: [], economy: [] };
    row.cands[t.cls].push(t, ...t.fallbacks);
  }
  for (const row of rows.values()) {
    for (const cls of CLASSES) {
      row.cands[cls].sort((a, b) => a.total - b.total);
      row[cls] = overall(row.cands[cls][0], trips);
    }
  }
  return sortRows([...rows.values()]);
}

// A trip as the dashboard stores it, without the builder's keys.
// tier: the price tier word (config/alerts.json), shared with the alerts.
const strip = ({ home, in: _i, out: _o, cls, month, safe, fallbacks, via, ...trip }) => ({ ...trip, tier: tierOf(alertConfig, cls, trip.total) });
// An overall cell: its own copy of the tickets (flight details go there, not on the month twin)
// and +N counted across months.
const overall = (t, trips) => t && { ...strip(t), tickets: t.tickets.map((x) => ({ ...x })), alts: t.via ? 0 : similarCount(trips.dateSets, t) };
const price = (t) => t?.total ?? Infinity;
const sortRows = (rows) => rows.sort((a, b) => price(a.hybrid) - price(b.hybrid) || price(a.economy) - price(b.economy));

/**
 * Check every row's overall cells against real flights (byHome: any map of row lists). Each
 * cell walks its candidates cheapest first (graph prices), keeping the cheapest that connects at
 * listed prices, until the next candidate's graph total can't beat it, or after TRIES. None
 * connects: the cell is dropped (a row with neither class goes too); a trip that can't be flown
 * is not a price.
 */
async function verify(byHome, trips) {
  const t0 = Date.now();
  const cache = new Map();
  // Searches whose page inlines no results are asked again in a real page (gflights/flights.js).
  const { browser: chrome, ctx } = await openBrowser();
  let browserSearches = 0;
  const browser = (q, opts) => { browserSearches++; return shoppingResults(ctx, q, opts); };
  const st = { cells: 0, replaced: 0, unresolved: 0, searches: 0, failed: 0, none: 0, stay: 0 };
  let pending = [...byHome.values()].flatMap((rows) => rows.flatMap((r) => CLASSES.filter((c) => r[c]).map((cls) => ({ r, cls, i: 0, cand: r[cls], best: null, first: null }))));
  st.cells = pending.length;
  while (pending.length) {
    const s = await addDetails(pending.map((p) => p.cand), cache, browser);
    st.searches += s.searches;
    st.failed += s.failed;
    st.error ??= s.error;
    st.none += s.none;
    st.stay += s.stay;
    pending = pending.filter((p) => {
      p.first ??= p.cand;
      if (p.cand.connects && !(p.best?.total <= p.cand.total)) p.best = p.cand;
      const next = p.r.cands[p.cls][++p.i];
      if (next && p.i < TRIES && !(p.best && next.total >= p.best.total)) {
        p.cand = overall(next, trips);
        return true;
      }
      if (p.best) p.best.tier = tierOf(alertConfig, p.cls, p.best.total);
      p.r[p.cls] = p.best;
      if (!p.best) st.unresolved++;
      else if (p.best !== p.first) st.replaced++;
      return false;
    });
  }
  await chrome.close();
  st.browser = browserSearches;
  for (const [view, rows] of byHome) {
    for (const r of rows) delete r.cands;
    byHome.set(view, sortRows(rows.filter((r) => r.hybrid || r.economy)));
  }
  return { ...st, ms: Date.now() - t0 };
}

/**
 * Multi-city single tickets (trips/multi.js) for the shown cells: the main views searched, most
 * promising first (an open jaw estimated at the cheaper return to either end, which is about what
 * airlines charge); the via views take the cached prices only. Re-tiers and re-sorts the rows.
 */
async function multiPass(dataDir, byHome, fares, search) {
  const cellsOf = (main) => [...byHome].filter(([v]) => v.endsWith('|') === main)
    .flatMap(([, rows]) => rows.flatMap((r) => CLASSES.map((cls) => r[cls] && Object.assign(r[cls], { cls })).filter(Boolean))); // groupsOf reads cls
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
    await applyMulti(dataDir, cellsOf(false), homes, null);
    for (const [view, rows] of byHome) {
      for (const r of rows) for (const cls of CLASSES) if (r[cls]) { delete r[cls].cls; r[cls].tier = tierOf(alertConfig, cls, r[cls].total); }
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

async function main() {
  const dataDir = arg('data');
  if (!dataDir) throw new Error('--data <dir> is required');
  const t0 = Date.now();
  const fares = loadFares(dataDir, config);
  const trips = buildTrips(fares);
  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const dayAgo = valuesAt(dataDir, new Date(Date.parse(generatedAt) - 864e5).toISOString().replace(/\.\d+Z$/, 'Z'));
  const cells = [];
  // Views: "HOME|" is the dashboard's, "HOME|CITY" the via filter's for each city.
  // A city every trip stays in (Da Nang) needs no view of its own.
  const main = trips.filter((t) => !t.via);
  const vias = [...new Set(trips.map((t) => t.via))].filter((c) => c && !main.every((t) => t.tickets.some((x) => x.to === c))).sort();
  const byHome = new Map(config.origins.flatMap((home) => ['', ...vias].map((via) => [`${home}|${via}`, rowsFor(home, trips, via)])));
  let details = null;
  if (!process.argv.includes('--no-details')) {
    const s = (details = await verify(byHome, trips));
    console.log(`details: ${s.cells} cells, ${s.replaced} moved to another trip (connects, or cheaper as listed), ${s.unresolved} with none that connects; ${s.searches} searches (${s.browser} in a browser, ${s.failed} failed${s.error ? `, e.g. ${s.error}` : ''}), ${s.none} flights not listed yet, ${s.stay} trips with a short Hoi An stay; ${s.ms}ms`);
  } else {
    for (const rows of byHome.values()) for (const r of rows) delete r.cands;
  }
  const m = await multiPass(dataDir, byHome, fares, !process.argv.includes('--no-details'));
  console.log(`multi-city: ${m.searched} searched (${m.failed} failed), ${m.merged} trips cheaper as one ticket; ${m.ms}ms`);
  if (details) details.multi = m;
  // Stay ranges on every shown trip; lowest-ever marks.
  for (const rows of byHome.values()) {
    for (const r of rows) {
      for (const trip of [r.hybrid, r.economy, ...Object.values(r.months).flatMap((m) => [m.hybrid, m.economy])]) {
        const flex = trip && flexOf(trip, fares);
        if (flex?.length) trip.flex = flex;
      }
    }
  }
  const views = (main) => Object.fromEntries([...byHome].filter(([v]) => v.endsWith('|') === main).map(([v, rows]) => [v, rows]));
  // Via views first: every view is marked against the lows before this build, then the main ones record.
  for (const [v, rows] of Object.entries(views(false))) markLows(dataDir, { [v.split('|')[0]]: rows }, generatedAt, { record: false });
  markLows(dataDir, Object.fromEntries(Object.entries(views(true)).map(([v, rows]) => [v.slice(0, -1), rows])), generatedAt);
  fs.rmSync(path.join(dataDir, 'derived', 'via'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, 'derived', 'via'), { recursive: true });
  for (const [view, rows] of byHome) {
    const [home, via] = view.split('|');
    if (via) {
      if (rows.length) fs.writeFileSync(path.join(dataDir, 'derived', 'via', `trips-${home}-${via}.json`), JSON.stringify({ generatedAt, home, via, rows }));
      continue;
    }
    for (const r of rows) {
      for (const cls of CLASSES) {
        if (!r[cls]) continue;
        const cell = { home, cls, in: r.in, out: r.out, total: r[cls].total };
        cells.push(cell);
        const was = dayAgo.get(keyOf(cell));
        if (was != null) r[cls].was = was;
      }
    }
    fs.mkdirSync(path.join(dataDir, 'derived'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'derived', `trips-${home}.json`), JSON.stringify({ generatedAt, home, vias, rows })); // compact: the phone loads it
    const top = rows[0]?.hybrid;
    console.log(`${home}: ${rows.length} rows${top ? `, best hybrid ${rows[0].in}/${rows[0].out} ${top.total} (${top.depart}…${top.ret})` : ''}`);
  }
  const changed = recordHistory(dataDir, generatedAt, cells);
  fs.writeFileSync(path.join(dataDir, 'derived', 'fares.json'), JSON.stringify({ ...bundleOf(fares), tiers: alertConfig.tiers }));
  fs.writeFileSync(path.join(dataDir, 'derived', 'status.json'), JSON.stringify({ generatedAt, details, routes: freshness(dataDir), alerts: alertConfig }));
  console.log(`built ${trips.length} trips, ${changed} cells changed, from ${fares.departures.length} departure days in ${Date.now() - t0}ms`);
}
main().catch((e) => { console.error(e); process.exit(1); });
