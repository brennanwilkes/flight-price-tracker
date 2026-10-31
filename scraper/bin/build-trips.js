#!/usr/bin/env node
'use strict';
/* Build trips from the data branch's current fares and write what the dashboard reads:
 *
 *   derived/trips-<HOME>.json   { generatedAt, home, rows: [{ in, out, hybrid, economy, months: { "<YYYY-MM>": { hybrid, economy } } }] }
 *
 * One row per in/out city pair; each cell is that pair's cheapest trip (null when none), overall
 * and per departure month. Rows sorted by cheapest hybrid, then cheapest economy.
 *
 *   node scraper/bin/build-trips.js --data <dataDir>
 */
const path = require('node:path');
const config = require('../config/sweep.json');
const { loadFares } = require('../src/trips/fares');
const { buildTrips } = require('../src/trips/build');
const { writeJson } = require('../src/store/routes');

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
  for (const home of config.origins) {
    const rows = rowsFor(home, trips);
    writeJson(path.join(dataDir, 'derived', `trips-${home}.json`), { generatedAt, home, rows });
    const top = rows[0]?.hybrid;
    console.log(`${home}: ${rows.length} rows${top ? `, best hybrid ${rows[0].in}/${rows[0].out} ${top.total} (${top.depart}…${top.ret})` : ''}`);
  }
  console.log(`built ${trips.length} trips from ${fares.departures.length} departure days in ${Date.now() - t0}ms`);
}
main();
