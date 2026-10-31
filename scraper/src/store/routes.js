'use strict';
/* Data-branch storage for swept prices. History is explicit append-only files, never git history:
 *
 *   routes/<ID>/current.json     { "<out>|<tripLen>": { ret, price, seen, first } }  latest value per cell
 *   routes/<ID>/<YYYY-MM>.csv    observed_at,out,ret,trip_len,price_cad,egress  (month = observed_at)
 *
 * <ID> is <O>-<D>-<cabin>, e.g. YVR-TYO-J. A CSV row is written only when a cell's price changes,
 * including to/from empty (price null = Google lists no fare for that date pair). `first` is when
 * the cell first had a price: the fare-loading log.
 */
const fs = require('node:fs');
const path = require('node:path');

const CSV_HEADER = 'observed_at,out,ret,trip_len,price_cad,egress\n';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
}

/**
 * Merge one successful sweep of a route+cabin+trip length into the store.
 * Only cells Google returned are touched: a cell outside this sweep's range keeps its old value.
 * Returns the number of changed cells (rows appended).
 */
function recordCells(dataDir, routeId, tripLen, cells, { observedAt, egress }) {
  const dir = path.join(dataDir, 'routes', routeId);
  const curFile = path.join(dir, 'current.json');
  const current = readJson(curFile, {});
  const rows = [];
  for (const c of cells) {
    const key = `${c.out}|${tripLen}`;
    const prev = current[key];
    const price = c.price ?? null;
    if (!prev || prev.price !== price) rows.push(`${observedAt},${c.out},${c.ret ?? ''},${tripLen},${price ?? ''},${egress}`);
    current[key] = { ret: c.ret, price, seen: observedAt, first: prev?.first ?? (price != null ? observedAt : null) };
  }
  if (rows.length) {
    const csv = path.join(dir, `${observedAt.slice(0, 7)}.csv`);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(csv)) fs.writeFileSync(csv, CSV_HEADER);
    fs.appendFileSync(csv, `${rows.join('\n')}\n`);
  }
  writeJson(curFile, Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b))));
  return rows.length;
}

module.exports = { recordCells, readJson, writeJson };
