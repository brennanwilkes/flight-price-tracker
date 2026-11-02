'use strict';
/* The hop network: which Asia city pairs have a real short flight (nonstop, or 1 stop within
 * MAX_ONE_STOP_MIN). Hops and Asia returns are only scraped over these pairs; longer trips are
 * built from two hops.
 *
 * One plain search per ordered pair on a near-term date (schedules loaded), a second date only when
 * the first finds nothing short (some routes don't fly daily). Each sweep re-checks the stalest
 * pairs (planNetwork), so the whole network is re-mapped about weekly.
 * state/network.json: { pairs: { 'A-B': { at, stops, min, price } | { at, none: true } } }.
 */
const { search } = require('../gflights/flights');
const { addDays } = require('../gflights/browser');
const { citiesWith, airportsOf, isPacific } = require('../../../frontend/app/cities.js');

const MAX_ONE_STOP_MIN = 8 * 60;
const DAYS_OUT = [40, 44];
const MAX_AGE_DAYS = 7;
const CONCURRENCY = 6;

const short = (o) => o.stops.length === 0 || (o.stops.length === 1 && o.min <= MAX_ONE_STOP_MIN);

/**
 * Pairs due a check: never checked first (gateway pairs before hop-only ones), then oldest; at most
 * `max`. Pacific stops (cities.js) pair with the gateways only: the long haul's second half.
 */
function planNetwork(network, now, max) {
  const cities = citiesWith('gateway', 'hop', 'pacific');
  const gateways = new Set(citiesWith('gateway'));
  const due = [];
  for (const a of cities) {
    for (const b of cities) {
      if ((isPacific(a) || isPacific(b)) && !gateways.has(a) && !gateways.has(b)) continue;
      const at = network.pairs?.[`${a}-${b}`]?.at;
      const rank = (gateways.has(a) ? 0 : 1) + (gateways.has(b) ? 0 : 1);
      if (a !== b && (!at || now - Date.parse(at) > MAX_AGE_DAYS * 864e5)) due.push({ a, b, last: at ? Date.parse(at) : 0, rank });
    }
  }
  return due.sort((x, y) => x.last - y.last || x.rank - y.rank).slice(0, max).map(({ a, b }) => [a, b]);
}

/** Check `pairs` ([[a, b]]) and record them in `network` (mutated). Returns { checked, kept, failed }. */
async function checkPairs(network, pairs, { browser = null, at = new Date().toISOString() } = {}) {
  const dates = DAYS_OUT.map((n) => addDays(at.slice(0, 10), n));
  const stats = { checked: 0, kept: 0, failed: 0 };
  network.pairs ??= {};
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < pairs.length) {
      const [a, b] = pairs[next++];
      let found = null;
      let failed = false;
      for (const out of dates) {
        let opts;
        try { opts = await search({ from: airportsOf(a), to: airportsOf(b), out, cabin: 'Y' }, { browser }); } catch { failed = true; continue; }
        const ok = opts.filter(short);
        if (!ok.length) continue;
        const best = ok.slice().sort((x, y) => x.stops.length - y.stops.length || x.min - y.min)[0];
        found = { at, stops: best.stops.length, min: best.min, price: Math.min(...ok.map((o) => o.price)) };
        break;
      }
      stats.checked++;
      if (found) { network.pairs[`${a}-${b}`] = found; stats.kept++; }
      else if (failed) stats.failed++; // keep what we knew
      else network.pairs[`${a}-${b}`] = { at, none: true };
    }
  }));
  network.pairs = Object.fromEntries(Object.entries(network.pairs).sort(([x], [y]) => x.localeCompare(y)));
  return stats;
}

/** Pairs with a short flight, as 'A-B' keys: within Asia, or with `pacific` a Pacific stop's (cities.js). */
const routesOf = (network, pacific = false) => Object.keys(network.pairs ?? {})
  .filter((k) => !network.pairs[k].none && k.split('-').some(isPacific) === pacific);

module.exports = { planNetwork, checkPairs, routesOf, MAX_ONE_STOP_MIN };
