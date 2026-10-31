'use strict';
/* Lowest prices ever shown, for the dashboard's markers (SCOPE, Decisions 2026-10-31):
 *   ★ the cheapest this route has been, at any dates
 *   these exact dates were cheaper before (bad: the price went up)
 *   another date set on this route was cheaper (mildly bad)
 *
 * state/lows.json: { 'home,class,in,out': { 'depart,ret': { total, at } } }, from cells checked
 * against listed flights only (graph prices can be stale). Date sets already flown are dropped.
 *
 * And per ticket, so the trip view shows which leg moved the price: state/ticket-lows.json
 * { 'kind,cabin,route': { dates: { total, at } } } (route "YVR-MNL", or a multi-city ticket's
 * "YVR-MNL SGN-YVR"; dates its flights' days, a return's two), each ticket's `low` alike.
 */
const path = require('node:path');
const { readJson, writeJson } = require('../store/routes');

const routeOf = (home, cls, r) => `${home},${cls},${r.in},${r.out}`;
const ticketRoute = (t) => `${t.kind},${t.cabin},${t.kind === 'multi' ? t.legs.map((l) => `${l.from}-${l.to}`).join(' ') : `${t.from}-${t.to}`}`;
const ticketDates = (t) => (t.kind === 'multi' ? t.legs.map((l) => l.date) : t.kind === 'rt' ? [t.date, t.ret] : [t.date]).join(',');

/** The lows of one ledger entry ({ dates: { total, at } }) for `dates`: { any: { total, dates }, same? }. */
function lowIn(entry, dates) {
  const seen = Object.entries(entry ?? {});
  if (!seen.length) return null;
  const [best, low] = seen.reduce((a, b) => (b[1].total < a[1].total ? b : a));
  return { any: { total: low.total, dates: best }, ...(entry[dates] ? { same: entry[dates] } : {}) };
}
const keepLow = (ledger, route, dates, total, at) => {
  ledger[route] ??= {};
  if (!(ledger[route][dates]?.total <= total)) ledger[route][dates] = { total, at };
};
/** Drop date sets already flown (a key's first date before today) and emptied routes. */
function prune(ledger, today) {
  for (const route of Object.keys(ledger)) {
    for (const k of Object.keys(ledger[route])) if (k.slice(0, 10) < today) delete ledger[route][k];
    if (!Object.keys(ledger[route]).length) delete ledger[route];
  }
}

/**
 * Mark every cell of the given rows ({ home: rows }) with `low` ({ any?: { total, depart, ret },
 * same?: { total, at } }: the lows before this build), then record the overall cells' prices
 * (`record` false: only mark, e.g. the via views, whose cells the main view already has).
 */
function markLows(dataDir, rowsByHome, at, { record: save = true } = {}) {
  const file = path.join(dataDir, 'state', 'lows.json');
  const ticketFile = path.join(dataDir, 'state', 'ticket-lows.json');
  const ledger = readJson(file, {});
  const tickets = readJson(ticketFile, {});
  const lowOf = (route, trip) => {
    const low = lowIn(ledger[route], `${trip.depart},${trip.ret}`);
    if (!low) return null;
    const [depart, ret] = low.any.dates.split(',');
    return { ...low, any: { total: low.any.total, depart, ret } };
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
          for (const t of trip.tickets ?? []) {
            const tl = lowIn(tickets[ticketRoute(t)], ticketDates(t));
            if (tl) t.low = tl;
          }
        }
        if (save && r[cls]?.connects === true) record.push([route, r[cls]]);
      }
    }
  }
  for (const [route, trip] of record) {
    keepLow(ledger, route, `${trip.depart},${trip.ret}`, trip.total, at);
    for (const t of trip.tickets ?? []) keepLow(tickets, ticketRoute(t), ticketDates(t), t.price, at);
  }
  if (!save) return;
  prune(ledger, at.slice(0, 10));
  prune(tickets, at.slice(0, 10));
  writeJson(file, ledger);
  writeJson(ticketFile, tickets);
}

module.exports = { markLows };
