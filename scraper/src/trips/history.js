'use strict';
/* Price history of the dashboard's cells, for the ▲/▼ vs 24 h and the history page:
 *
 *   derived/history/<YYYY-MM-DD>.csv   generated_at,home,class,in,out,total   (day = generated_at's;
 *   <YYYY-MM>.csv a month to Nov 24, 2026)
 *
 * One cell = the cheapest trip for (home, class, board row) over all dates; out holds the row's
 * throw-ins too, "+"-joined after it ("DPS+HAN+SIN", build.js rowId). A row is
 * written only when a cell's total changes, including to empty (no trip any more), so the files
 * replay to the value of every cell at any time.
 */
const fs = require('node:fs');
const path = require('node:path');

const HEADER = 'generated_at,home,class,in,out,total\n';
const keyOf = (c) => `${c.home},${c.cls},${c.in},${c.out}${c.set ? `+${c.set}` : ''}`;
const monthBefore = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

// A file a day (<YYYY-MM-DD>.csv) from Nov 24, 2026; a file a month (<YYYY-MM>.csv) before. A
// month's grew ~4.7 MB a day (Nov 24): December's would pass GitHub's 100 MB file limit by the 20th.
// In time order: a month's file before its days' (it ends where they start).
const order = (f) => (f.length === 'YYYY-MM.csv'.length ? `${f.slice(0, 7)}-00` : f);
function historyFiles(dataDir, fromYm, toDay) {
  const dir = path.join(dataDir, 'derived', 'history');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}(-\d{2})?\.csv$/.test(f))
    .filter((f) => f.slice(0, 7) >= fromYm && order(f).slice(0, 10) <= toDay)
    .sort((a, b) => (order(a) < order(b) ? -1 : 1)).map((f) => path.join(dir, f));
}

/** Each cell's total as of `at` (ISO), from this month's and last month's files. Map key → total. */
function valuesAt(dataDir, at) {
  const values = new Map();
  for (const file of historyFiles(dataDir, monthBefore(at.slice(0, 7)), at.slice(0, 10))) {
    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n').slice(1)) {
      const [when, home, cls, inn, out, total] = line.split(',');
      if (when > at) break;
      values.set(`${home},${cls},${inn},${out}`, total === '' ? null : Number(total));
    }
  }
  return values;
}

/** Each cell's lowest total in all its history. Map key → total. */
function lowestEver(dataDir) {
  const lows = new Map();
  const dir = path.join(dataDir, 'derived', 'history');
  if (!fs.existsSync(dir)) return lows;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.csv'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').slice(1)) {
      const [, home, cls, inn, out, total] = line.split(',');
      const key = `${home},${cls},${inn},${out}`;
      if (total !== '' && !(lows.get(key) <= Number(total))) lows.set(key, Number(total));
    }
  }
  return lows;
}

/**
 * Append the cells that changed since the last run. `cells`: [{ home, cls, in, out, set, total }], the
 * complete current set: a cell missing from it that had a value is recorded as gone.
 * Returns the number of rows written.
 */
function recordHistory(dataDir, generatedAt, cells) {
  const last = valuesAt(dataDir, generatedAt);
  const now = new Map(cells.map((c) => [keyOf(c), c.total]));
  const rows = [];
  for (const [key, total] of now) if (last.get(key) !== total) rows.push(`${generatedAt},${key},${total}`);
  for (const [key, total] of last) if (total != null && !now.has(key)) rows.push(`${generatedAt},${key},`);
  if (rows.length) {
    const file = path.join(dataDir, 'derived', 'history', `${generatedAt.slice(0, 10)}.csv`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, HEADER);
    fs.appendFileSync(file, `${rows.sort().join('\n')}\n`);
  }
  return rows.length;
}

/**
 * The History tab's file (derived/history-days-<HOME>.json): each cell's lowest live total each
 * Vancouver day (UTC-7), the total carried in at midnight counted; it fetched and replayed every
 * row (62 MB, 1.3M lines on Nov 24) in the phone to draw one point a day. Per home:
 * { keys: { "cls,in,out[+set]": [first day, last day if gone else null, [low|null a day]] } }, a day
 * being days since 1970-01-01 in Vancouver; null: no live price all day (held, or gone after `last`).
 */
const VAN_MS = 7 * 3600e3;
const dayOf = (iso) => Math.floor((Date.parse(iso) - VAN_MS) / 864e5);
function writeHistoryDays(dataDir, homes, generatedAt) {
  const today = dayOf(generatedAt);
  const by = new Map(homes.map((h) => [h, {}]));
  for (const file of historyFiles(dataDir, '0000-00', '9999-99-99')) {
    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n').slice(1)) {
      const [when, home, cls, inn, out, total] = line.split(',');
      const keys = by.get(home);
      if (!keys) continue;
      const d = dayOf(when);
      const y = total === '' ? null : Number(total);
      const k = `${cls},${inn},${out}`;
      const st = (keys[k] ??= { s: d, day: d, cur: null, v: [null] });
      for (; st.day < d; st.day++) st.v.push(st.cur); // days carried through, then this one's carried-in
      st.cur = y;
      st.at = d;
      const i = d - st.s;
      if (y != null && (st.v[i] == null || y < st.v[i])) st.v[i] = y;
    }
  }
  for (const [home, keys] of by) {
    const out = {};
    for (const [k, st] of Object.entries(keys)) {
      for (; st.day < today; st.day++) st.v.push(st.cur);
      out[k] = [st.s, st.cur == null ? st.at : null, st.v];
    }
    fs.writeFileSync(path.join(dataDir, 'derived', `history-days-${home}.json`), JSON.stringify({ generatedAt, keys: out }));
  }
}

module.exports = { recordHistory, valuesAt, lowestEver, keyOf, writeHistoryDays };
