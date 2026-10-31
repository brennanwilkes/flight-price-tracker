'use strict';
/* Price history of the dashboard's cells, for the ▲/▼ vs 24 h and the history page:
 *
 *   derived/history/<YYYY-MM>.csv   generated_at,home,class,in,out,total   (month = generated_at)
 *
 * One cell = the cheapest trip for (home, class, in-city, out-city) over all dates. A row is
 * written only when a cell's total changes, including to empty (no trip any more), so the files
 * replay to the value of every cell at any time.
 */
const fs = require('node:fs');
const path = require('node:path');

const HEADER = 'generated_at,home,class,in,out,total\n';
const keyOf = (c) => `${c.home},${c.cls},${c.in},${c.out}`;
const monthBefore = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/** Each cell's total as of `at` (ISO), from this month's and last month's files. Map key → total. */
function valuesAt(dataDir, at) {
  const values = new Map();
  for (const ym of [monthBefore(at.slice(0, 7)), at.slice(0, 7)]) {
    const file = path.join(dataDir, 'derived', 'history', `${ym}.csv`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n').slice(1)) {
      const [when, home, cls, inn, out, total] = line.split(',');
      if (when > at) break;
      values.set(`${home},${cls},${inn},${out}`, total === '' ? null : Number(total));
    }
  }
  return values;
}

/**
 * Append the cells that changed since the last run. `cells`: [{ home, cls, in, out, total }], the
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
    const file = path.join(dataDir, 'derived', 'history', `${generatedAt.slice(0, 7)}.csv`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, HEADER);
    fs.appendFileSync(file, `${rows.sort().join('\n')}\n`);
  }
  return rows.length;
}

module.exports = { recordHistory, valuesAt, keyOf };
