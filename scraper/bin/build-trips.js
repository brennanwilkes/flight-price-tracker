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
 *   node scraper/bin/build-trips.js --data <dataDir>
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config/sweep.json');
const { loadFares } = require('../src/trips/fares');
const { buildTrips } = require('../src/trips/build');
const { recordHistory, valuesAt, keyOf } = require('../src/trips/history');

const CLASSES = ['hybrid', 'economy'];

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
    const { home: _h, in: _i, out: _o, cls, month, ...trip } = t;
    row.months[month] ??= { hybrid: null, economy: null };
    row.months[month][cls] = trip;
    if (!row[cls] || row[cls].total > trip.total) row[cls] = trip;
  }
  const price = (t) => t?.total ?? Infinity;
  return [...rows.values()].sort((a, b) => price(a.hybrid) - price(b.hybrid) || price(a.economy) - price(b.economy));
}

function main() {
  const dataDir = arg('data');
  if (!dataDir) throw new Error('--data <dir> is required');
  const t0 = Date.now();
  const fares = loadFares(dataDir, config);
  const trips = buildTrips(fares);
  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const dayAgo = valuesAt(dataDir, new Date(Date.parse(generatedAt) - 864e5).toISOString().replace(/\.\d+Z$/, 'Z'));
  const cells = [];
  for (const home of config.origins) {
    const rows = rowsFor(home, trips);
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
main();
