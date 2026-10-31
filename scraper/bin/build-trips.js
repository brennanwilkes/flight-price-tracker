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
 * Every row's overall cells get the actual flights on each ticket
 * (src/trips/details.js; skipped with --no-details). The price graph has no times, so a cell's
 * cheapest trip can have a connection no flight makes; then the next cheapest candidate (any month,
 * plus the builder's fallbacks) is checked, up to TRIES, and rows re-sort on what connects.
 *
 *   node scraper/bin/build-trips.js --data <dataDir> [--no-details]
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config/sweep.json');
const { loadFares } = require('../src/trips/fares');
const { buildTrips, similarCount } = require('../src/trips/build');
const { recordHistory, valuesAt, keyOf } = require('../src/trips/history');
const { addDetails } = require('../src/trips/details');
const alertConfig = require('../config/alerts.json');
const { tierOf } = require('../src/alerts/rules');

const CLASSES = ['hybrid', 'economy'];
const DETAIL_ROWS = Infinity; // every row: ~4 searches a cell, ~1 s each, 4 at a time (~3 min a sweep)
const TRIES = 6;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

function rowsFor(home, trips) {
  const rows = new Map();
  for (const t of trips) {
    if (t.home !== home) continue;
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
const strip = ({ home, in: _i, out: _o, cls, month, safe, fallbacks, ...trip }) => ({ ...trip, tier: tierOf(alertConfig, cls, trip.total) });
// An overall cell: its own copy of the tickets (flight details go there, not on the month twin)
// and +N counted across months.
const overall = (t, trips) => t && { ...strip(t), tickets: t.tickets.map((x) => ({ ...x })), alts: similarCount(trips.dateSets, t) };
const price = (t) => t?.total ?? Infinity;
const sortRows = (rows) => rows.sort((a, b) => price(a.hybrid) - price(b.hybrid) || price(a.economy) - price(b.economy));

/**
 * Check the top rows' overall cells against real flights. A cell whose trip doesn't connect moves
 * to its next candidate; if none of TRIES connects it keeps the cheapest, which shows its own bad
 * connection.
 */
async function verify(byHome, trips) {
  const t0 = Date.now();
  const cache = new Map();
  const st = { cells: 0, replaced: 0, unresolved: 0, searches: 0, failed: 0, none: 0 };
  let pending = [...byHome.values()].flatMap((rows) => rows.slice(0, DETAIL_ROWS).flatMap((r) => CLASSES.filter((c) => r[c]).map((cls) => ({ r, cls, i: 0, first: r[cls] }))));
  st.cells = pending.length;
  for (let round = 0; pending.length; round++) {
    const s = await addDetails(pending.map((p) => p.r[p.cls]), config.origins, cache);
    st.searches += s.searches;
    st.failed += s.failed;
    st.none += s.none;
    pending = pending.filter((p) => {
      if (p.r[p.cls].connects) {
        if (p.i) st.replaced++;
        return false;
      }
      const next = round < TRIES - 1 && p.r.cands[p.cls][++p.i];
      p.r[p.cls] = next ? overall(next, trips) : p.first;
      if (!next) st.unresolved++;
      return !!next;
    });
  }
  for (const rows of byHome.values()) {
    for (const r of rows) delete r.cands;
    sortRows(rows);
  }
  return { ...st, ms: Date.now() - t0 };
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
  const byHome = new Map(config.origins.map((home) => [home, rowsFor(home, trips)]));
  if (!process.argv.includes('--no-details')) {
    const s = await verify(byHome, trips);
    console.log(`details: ${s.cells} cells, ${s.replaced} moved to a trip that connects, ${s.unresolved} with none; ${s.searches} searches (${s.failed} failed), ${s.none} flights not listed yet; ${s.ms}ms`);
  } else {
    for (const rows of byHome.values()) for (const r of rows) delete r.cands;
  }
  for (const [home, rows] of byHome) {
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
    fs.writeFileSync(path.join(dataDir, 'derived', `trips-${home}.json`), JSON.stringify({ generatedAt, home, rows })); // compact: the phone loads it
    const top = rows[0]?.hybrid;
    console.log(`${home}: ${rows.length} rows${top ? `, best hybrid ${rows[0].in}/${rows[0].out} ${top.total} (${top.depart}…${top.ret})` : ''}`);
  }
  const changed = recordHistory(dataDir, generatedAt, cells);
  console.log(`built ${trips.length} trips, ${changed} cells changed, from ${fares.departures.length} departure days in ${Date.now() - t0}ms`);
}
main().catch((e) => { console.error(e); process.exit(1); });
