'use strict';
/* Fare lookups for the trip builder, read from the data branch's routes/<ID>/current.json files
 * (src/store/routes.js). A cell not re-seen within maxAgeHours is dropped: Google stopped listing
 * it, or the sweep for it keeps failing; either way it's not a price to show.
 */
const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('../store/routes');

function loadFares(dataDir, config, { now = Date.now(), maxAgeHours = 48 } = {}) {
  const homes = config.origins;
  const cities = Object.keys(config.destinations);
  const fresh = (c) => c.price != null && now - Date.parse(c.seen) <= maxAgeHours * 3600e3;
  const routesDir = path.join(dataDir, 'routes');
  const ids = fs.existsSync(routesDir) ? fs.readdirSync(routesDir) : [];

  const rt = new Map(); // "home|city|cabin|out" → [{ ret, price }]
  const ow = new Map(); // "from|to|cabin|date" → price (long legs and hops)
  const departures = new Set();
  for (const id of ids) {
    const parts = id.split('-');
    const oneWay = parts.at(-1) === 'OW';
    const [from, to, cabin] = parts;
    for (const [key, c] of Object.entries(readJson(path.join(routesDir, id, 'current.json'), {}))) {
      if (!fresh(c)) continue;
      const out = key.split('|')[0];
      if (oneWay) {
        ow.set(`${from}|${to}|${cabin}|${out}`, c.price);
        if (homes.includes(from)) departures.add(out);
      } else {
        const k = `${from}|${to}|${cabin}|${out}`;
        if (!rt.has(k)) rt.set(k, []);
        rt.get(k).push({ ret: c.ret, price: c.price });
        departures.add(out);
      }
    }
  }

  return {
    homes,
    cities,
    departures: [...departures].sort(),
    roundTrip: (home, city, cabin, out) => rt.get(`${home}|${city}|${cabin}|${out}`) ?? [],
    oneWay: (from, to, cabin, date) => ow.get(`${from}|${to}|${cabin}|${date}`) ?? null,
    hop: (from, to, date) => ow.get(`${from}|${to}|${config.hops.cabin}|${date}`) ?? null,
  };
}

module.exports = { loadFares };
