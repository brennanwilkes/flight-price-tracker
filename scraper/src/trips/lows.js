'use strict';
/* Lowest prices ever shown, for the dashboard's markers (SCOPE, Decisions 2026-10-31):
 *   ★ the cheapest this route has been, at any dates
 *   these exact dates were cheaper before (bad: the price went up)
 *   another date set on this route was cheaper (mildly bad)
 *
 * state/lows.json: { 'home,class,in,out': { 'depart,ret': { total, at } } }, from cells checked
 * against listed flights only (graph prices can be stale). Date sets already flown are dropped.
 */
const path = require('node:path');
const { readJson, writeJson } = require('../store/routes');

const routeOf = (home, cls, r) => `${home},${cls},${r.in},${r.out}`;

/**
 * Mark every cell of the given rows ({ home: rows }) with `low` ({ any?: { total, depart, ret },
 * same?: { total, at } }: the lows before this build), then record the overall cells' prices
 * (`record` false: only mark, e.g. the via views, whose cells the main view already has).
 */
function markLows(dataDir, rowsByHome, at, { record: save = true } = {}) {
  const file = path.join(dataDir, 'state', 'lows.json');
  const ledger = readJson(file, {});
  const lowOf = (route, trip) => {
    const seen = Object.entries(ledger[route] ?? {});
    if (!seen.length) return null;
    const [dates, best] = seen.reduce((a, b) => (b[1].total < a[1].total ? b : a));
    const [depart, ret] = dates.split(',');
    const same = ledger[route][`${trip.depart},${trip.ret}`];
    return { any: { total: best.total, depart, ret }, ...(same ? { same } : {}) };
  };
  const record = [];
  for (const [home, rows] of Object.entries(rowsByHome)) {
    for (const r of rows) {
      for (const cls of ['hybrid', 'economy']) {
        const route = routeOf(home, cls, r);
        for (const trip of [r[cls], ...Object.values(r.months ?? {}).map((m) => m[cls])]) {
          if (!trip) continue;
          const low = lowOf(route, trip);
          if (low) trip.low = low;
        }
        if (save && r[cls]?.connects === true) record.push([route, r[cls]]);
      }
    }
  }
  for (const [route, trip] of record) {
    const k = `${trip.depart},${trip.ret}`;
    ledger[route] ??= {};
    if (!(ledger[route][k]?.total <= trip.total)) ledger[route][k] = { total: trip.total, at };
  }
  const today = at.slice(0, 10);
  for (const route of Object.keys(ledger)) {
    for (const k of Object.keys(ledger[route])) if (k < today) delete ledger[route][k];
    if (!Object.keys(ledger[route]).length) delete ledger[route];
  }
  if (save) writeJson(file, ledger);
}

module.exports = { markLows };
