'use strict';
/* Fare lookups for the trip builder, read from the data branch's routes/<ID>/current.json files
 * (src/store/routes.js). A cell not re-seen within twice its graph's max age (≥ 48 h,
 * sweep/plan.js) is dropped: Google stopped listing it, or the sweep for it keeps failing; either
 * way it's not a price to show.
 */
const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('../store/routes');
const { staleAfterHours } = require('../sweep/plan');
const { citiesWith, CITIES } = require('../../../frontend/app/cities.js');

function loadFares(dataDir, config, { now = Date.now() } = {}) {
  const homes = config.origins;
  const cities = citiesWith('gateway', 'hop');
  const network = readJson(path.join(dataDir, 'state', 'network.json'), { pairs: {} });
  const staleAfter = staleAfterHours(config, network);
  const routesDir = path.join(dataDir, 'routes');
  const ids = fs.existsSync(routesDir) ? fs.readdirSync(routesDir) : [];

  const rt = new Map(); // "from|to|cabin|out" → [{ ret, price }]
  const ow = new Map(); // "from|to|cabin|date" → price (long legs and hops)
  const departures = new Set();
  for (const id of ids) {
    const parts = id.split('-');
    const oneWay = parts.at(-1) === 'OW';
    const [from, to, cabin] = parts;
    for (const [key, c] of Object.entries(readJson(path.join(routesDir, id, 'current.json'), {}))) {
      const [out, tripLen] = key.split('|');
      if (c.price == null || now - Date.parse(c.seen) > staleAfter(id, Number(tripLen)) * 3600e3) continue;
      if (oneWay) {
        ow.set(`${from}|${to}|${cabin}|${out}`, c.price);
        if (homes.includes(from)) departures.add(out);
      } else {
        const k = `${from}|${to}|${cabin}|${out}`;
        if (!rt.has(k)) rt.set(k, []);
        rt.get(k).push({ ret: c.ret, price: c.price });
        if (homes.includes(from)) departures.add(out);
      }
    }
  }

  return {
    raw: { rt, ow }, // for bundleOf
    homes,
    cities,
    anchors: Object.fromEntries(Object.entries(CITIES).filter(([, c]) => c.vietnam != null).map(([k, c]) => [k, c.vietnam])),
    departures: [...departures].sort(),
    roundTrip: (from, to, cabin, out) => rt.get(`${from}|${to}|${cabin}|${out}`) ?? [], // long legs and Asia returns
    oneWay: (from, to, cabin, date) => ow.get(`${from}|${to}|${cabin}|${date}`) ?? null,
    asiaRT: (from, to, date) => rt.get(`${from}|${to}|Y|${date}`) ?? [],
    hop: (from, to, date) => ow.get(`${from}|${to}|Y|${date}`) ?? null,
  };
}

/**
 * The fares as one compact JSON value, for the page's own builds (the multi-city via filter):
 * { homes, cities, anchors, departures, base, ow: { "from-to-cabin": [day, price, …] },
 *   rt: { "from-to-cabin": [day, retDay, price, …] } }, days counted from `base`.
 * faresOf (frontend/app/fares.js) turns it back into what loadFares returns.
 */
function bundleOf(fares) {
  const base = fares.departures[0] ?? new Date().toISOString().slice(0, 10);
  const day = (iso) => Math.round((Date.parse(iso) - Date.parse(base)) / 864e5);
  const ow = {}, rt = {};
  for (const [k, price] of fares.raw.ow) {
    const [from, to, cabin, date] = k.split('|');
    (ow[`${from}-${to}-${cabin}`] ??= []).push(day(date), price);
  }
  for (const [k, list] of fares.raw.rt) {
    const [from, to, cabin, out] = k.split('|');
    for (const r of list) (rt[`${from}-${to}-${cabin}`] ??= []).push(day(out), day(r.ret), r.price);
  }
  const { homes, cities, anchors, departures } = fares;
  return { homes, cities, anchors, departures, base, ow, rt };
}

module.exports = { loadFares, bundleOf };
