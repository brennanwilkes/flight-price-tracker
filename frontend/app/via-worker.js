/* Module worker: the board's rows for trips staying in every one of several cities (the
 * multi-city via filter), built here from the fare bundle with the scraper's own builder. Graph
 * prices, no flight checks: the page shows these in place of its approximation.
 *
 *   postMessage({ id, url, home, need }) → { id, rows } | { id, error }
 */
import { buildTrips, similarCount } from './build.js';
import { faresOf } from './fares.js';
import { flexOf } from './flex.js';

const CLASSES = ['hybrid', 'economy'];
let loaded = null; // { url, fares }

onmessage = async ({ data: { id, url, home, need } }) => {
  try {
    if (loaded?.url !== url) {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`fares.json: HTTP ${res.status}`);
      loaded = { url, fares: faresOf(await res.json()) };
    }
    postMessage({ id, rows: rowsOf(loaded.fares, buildTrips(loaded.fares, { need, homes: [home] })) });
  } catch (e) {
    postMessage({ id, error: e.message });
  }
};

/** As scraper/bin/build-trips.js rowsFor: one row per in/out pair, cheapest per class overall and per month. */
function rowsOf(fares, trips) {
  const tier = (cls, total) => fares.tiers?.[cls].find(([max]) => total <= max)?.[1] ?? '';
  const cell = ({ home, in: _i, out: _o, cls, month, safe, fallbacks, via, ...t }) => {
    const flex = flexOf(t, fares);
    return { ...t, tier: tier(cls, t.total), ...(flex.length ? { flex } : {}) };
  };
  const rows = new Map();
  // Nothing here is checked against real flights, so per cell the cheapest trip with no same-day
  // connection (build.js isSafe: connects whatever the times), when there is one.
  for (const t of trips.map((c) => [c, ...c.fallbacks].find((x) => x.safe) ?? c)) {
    const key = `${t.in}-${t.out}`;
    if (!rows.has(key)) rows.set(key, { in: t.in, out: t.out, hybrid: null, economy: null, months: {} });
    const row = rows.get(key);
    (row.months[t.month] ??= { hybrid: null, economy: null })[t.cls] = cell(t);
    if (!(row[t.cls]?.total <= t.total)) row[t.cls] = { ...cell(t), alts: similarCount(trips.dateSets, t) };
  }
  return [...rows.values()];
}
