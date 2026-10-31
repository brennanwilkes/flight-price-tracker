'use strict';
/* What a sweep scrapes (SCOPE, coverage): every price graph has a tier with a max age; a sweep does
 * the most overdue graphs first until its time budget runs out, so important routes stay fresh and
 * the long tail gets done when there's room.
 *
 * Graphs (one price-graph page each, every departure day in the window):
 *   long  — home ⇄ gateway, per cabin: a round trip per trip length, and one-ways both ways
 *   hops  — economy one-ways between Asia cities, only over the hop network (src/network)
 *   asiaRT — economy round trips between a Vietnam anchor city and each city it has flights with
 *            (either end as origin), per trip length: a return nested inside the long-haul trip
 * state/graphs.json: { '<routeId>|<tripLen>': last successful scrape (ISO) }.
 */
const { citiesWith, CITIES } = require('../../../frontend/app/cities.js');
const { routesOf } = require('../network');

const key = (g) => `${g.routeId}|${g.tripLen ?? 0}`;
// A tier's round-trip lengths: `lengths` as listed, or every day in `lengthRange`.
const lengthsOf = (t) => t.lengths ?? (t.lengthRange ? Array.from({ length: t.lengthRange[1] - t.lengthRange[0] + 1 }, (_, i) => t.lengthRange[0] + i) : []);

/** Every graph the config asks for: [{ routeId, from, to, cabin, tripLen, maxAgeHours, tier }]. */
function allGraphs(config, network) {
  const gateways = citiesWith('gateway');
  const core = new Set(config.core);
  const vietnam = Object.keys(CITIES).filter((c) => CITIES[c].vietnam != null);
  const out = [];
  for (const [tier, t] of config.tiers.entries()) {
    const add = (g) => out.push({ ...g, maxAgeHours: t.maxAgeHours, tier });
    if (t.kind === 'long') {
      const cities = gateways.filter((c) => (t.cities === 'core' ? core.has(c) : t.cities === 'other' ? !core.has(c) : true));
      for (const home of t.homes) {
        for (const city of cities) {
          for (const cabin of config.longCabins) {
            for (const tripLen of lengthsOf(t)) add({ routeId: `${home}-${city}-${cabin}`, from: home, to: city, cabin, tripLen });
            if (t.oneWay) {
              add({ routeId: `${home}-${city}-${cabin}-OW`, from: home, to: city, cabin, tripLen: null });
              add({ routeId: `${city}-${home}-${cabin}-OW`, from: city, to: home, cabin, tripLen: null });
            }
          }
        }
      }
    } else if (t.kind === 'hops') {
      for (const pair of routesOf(network)) {
        const [a, b] = pair.split('-');
        const touchesVietnam = vietnam.includes(a) || vietnam.includes(b);
        if ((t.vietnam ?? touchesVietnam) !== touchesVietnam) continue;
        add({ routeId: `${a}-${b}-Y-OW`, from: a, to: b, cabin: 'Y', tripLen: null });
      }
    } else if (t.kind === 'asiaRT') {
      const routes = new Set(routesOf(network));
      for (const v of vietnam) {
        for (const p of citiesWith('gateway', 'hop')) {
          if (p === v || !routes.has(`${v}-${p}`) || !routes.has(`${p}-${v}`)) continue;
          for (const [a, b] of [[v, p], [p, v]]) {
            if (vietnam.includes(a) && vietnam.includes(b) && a > b) continue; // both anchors: one origin is enough
            for (const tripLen of lengthsOf(t)) add({ routeId: `${a}-${b}-Y`, from: a, to: b, cabin: 'Y', tripLen });
          }
        }
      }
    }
  }
  // A graph in two tiers keeps the stricter one.
  const byKey = new Map();
  for (const g of out) if (!byKey.has(key(g)) || byKey.get(key(g)).maxAgeHours > g.maxAgeHours) byKey.set(key(g), g);
  return [...byKey.values()];
}

/**
 * Graphs due this sweep, most overdue first (age / max age; never scraped counts as 1.5 so it
 * doesn't starve the hourly routes), then by tier. `only`: route prefixes (e.g. 'YVR-ICN').
 */
function planSweep(config, state, network, now, only = null) {
  const due = [];
  for (const g of allGraphs(config, network)) {
    if (only && !only.some((o) => g.routeId.startsWith(`${o}-`))) continue;
    const last = state[key(g)];
    const overdue = last ? (now - Date.parse(last)) / (g.maxAgeHours * 3600e3) : 1.5;
    if (only || overdue >= 1) due.push({ g, overdue });
  }
  return due.sort((x, y) => y.overdue - x.overdue || x.g.tier - y.g.tier).map((d) => d.g);
}

/** Hours after which a graph's cells are too old to build trips from: twice its max age, ≥ 48 h. */
function staleAfterHours(config, network) {
  const m = new Map(allGraphs(config, network).map((g) => [key(g), g.maxAgeHours]));
  return (routeId, tripLen) => Math.max(48, 2 * (m.get(`${routeId}|${tripLen ?? 0}`) ?? 24));
}

module.exports = { allGraphs, planSweep, staleAfterHours, graphKey: key };
