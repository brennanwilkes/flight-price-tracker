'use strict';
/* Single tickets for several flights ("multi-city" on Google), checked after the flight details.
 *
 * Google prices a multi-city ticket only for exact flights and dates (no price graph), so this is
 * a layer on top: the most promising shown trips, at most `budget` searches a build, results cached
 * for a day in state/multi.json. Groupings per trip:
 *   - open jaw: the two long one-ways (home → X, Y → home) as one ticket, the trip's long cabin
 *   - through a Pacific stop: every long-haul flight (home → stop → X … Y → stop → home) as one
 *     ticket, the long cabin: a stopover fare can beat the separate tickets
 *   - whole trip: every flight on one ticket, economy trips only (Google's search has one cabin)
 * A grouping that's cheaper than the tickets it replaces becomes one ticket:
 *   { kind: 'multi', from, to, date, legs: [{ from, to, date }], cabin, price, url, flights: { leg0, … } }
 * and the trip's order refers to its flights as [i, 'leg<k>'].
 */
const path = require('node:path');
const { readJson, writeJson } = require('../store/routes');
const { parseResults } = require('../gflights/flights');
const { pageUrl } = require('../gflights/page');
const { airportsOf, isLong, isPacific } = require('../../../frontend/app/cities.js');

const MAX_AGE_MS = 24 * 3600e3;
const CONCURRENCY = 6;

/** The flight [from, to, date] at an order entry. */
function flightAt(trip, [i, dir]) {
  const t = trip.tickets[i];
  if (dir === 'back') return { from: t.to, to: t.from, date: t.ret };
  if (dir.startsWith('leg')) return t.legs[Number(dir.slice(3))];
  return { from: t.from, to: t.to, date: t.date };
}

/** Candidate groupings: [{ replace: [ticket index], legs, cabin }]. */
function groupsOf(trip, homes) {
  const out = [];
  const long = trip.tickets.map((t, i) => [t, i]).filter(([t]) => homes.includes(t.from) || homes.includes(t.to));
  if (long.length === 2 && long.every(([t]) => t.kind === 'ow')) {
    out.push({ replace: long.map(([, i]) => i), legs: long.map(([t]) => ({ from: t.from, to: t.to, date: t.date })), cabin: long[0][0].cabin });
  }
  const longs = trip.tickets.map((t, i) => [t, i]).filter(([t]) => t.kind !== 'multi' && isLong(t.from, t.to, homes));
  if (longs.length > 2 && longs.some(([t]) => isPacific(t.from) || isPacific(t.to))) {
    const replace = longs.map(([, i]) => i);
    out.push({ replace, legs: trip.order.filter(([i]) => replace.includes(i)).map((e) => flightAt(trip, e)), cabin: longs[0][0].cabin });
  }
  if (trip.cls === 'economy' && trip.tickets.length > 1 && !(out.length && trip.tickets.length === 2)) {
    out.push({ replace: trip.tickets.map((_, i) => i), legs: trip.order.map((e) => flightAt(trip, e)), cabin: 'Y' });
  }
  return out;
}

const keyOf = (g) => `${g.cabin} ${g.legs.map((l) => `${l.from}-${l.to} ${l.date}`).join(', ')}`;
const queryOf = (g) => ({ from: airportsOf(g.legs[0].from), to: airportsOf(g.legs[0].to), cabin: g.cabin,
  legs: g.legs.map((l) => ({ from: airportsOf(l.from), to: airportsOf(l.to), date: l.date })) });

/** Replace `g.replace`'s tickets in `trip` with one multi-city ticket at `price`. */
function merge(trip, g, price) {
  const keep = trip.tickets.map((_, i) => i).filter((i) => !g.replace.includes(i));
  const at = Math.min(...g.replace);
  const newIndex = new Map();
  const tickets = [];
  for (const i of [...keep.filter((i) => i < at), at, ...keep.filter((i) => i > at)]) {
    newIndex.set(i, tickets.length);
    tickets.push(i === at ? null : trip.tickets[i]);
  }
  const mi = newIndex.get(at);
  const multi = { kind: 'multi', from: g.legs[0].from, to: g.legs.at(-1).to, date: g.legs[0].date, legs: g.legs, cabin: g.cabin, price,
    url: pageUrl(queryOf(g)), flights: {} };
  let k = 0;
  trip.order = trip.order.map(([i, dir]) => {
    if (!g.replace.includes(i)) return [newIndex.get(i), dir];
    const f = trip.tickets[i].flights?.[dir];
    if (f) multi.flights[`leg${k}`] = f;
    return [mi, `leg${k++}`];
  });
  tickets[mi] = multi;
  trip.tickets = tickets;
  trip.total = tickets.reduce((s, t) => s + t.price, 0);
}

/** The cached prices (state/multi.json), fresh ones only: key → { price, at }. */
function multiCache(dataDir, now = Date.now()) {
  const cache = readJson(path.join(dataDir, 'state', 'multi.json'), {});
  for (const [k, v] of Object.entries(cache)) if (now - Date.parse(v.at) > MAX_AGE_MS) delete cache[k];
  return cache;
}

/** What one ticket would save `trip`, by the cached prices only (a real search's, never an estimate): ≥ 0. */
function multiSaving(cache, trip, homes) {
  let best = 0;
  for (const g of groupsOf(trip, homes)) {
    const price = cache[keyOf(g)]?.price;
    if (price == null || g.replace.some((i) => !trip.tickets[i])) continue;
    best = Math.max(best, g.replace.reduce((s, i) => s + trip.tickets[i].price, 0) - price);
  }
  return best;
}

/**
 * Price groupings for `cells` (shown trips, most promising first) and merge the cheaper ones.
 * `browser(query, opts)` → GetShoppingResults payloads (null: cached results only). Returns stats.
 */
async function applyMulti(dataDir, cells, homes, browser, { budget = 80, now = Date.now() } = {}) {
  const file = path.join(dataDir, 'state', 'multi.json');
  const cache = multiCache(dataDir, now);
  const stats = { searched: 0, failed: 0, merged: 0 };
  const todo = new Map(); // key → grouping, in the cells' order
  if (browser) for (const trip of cells) for (const g of groupsOf(trip, homes)) if (!(keyOf(g) in cache) && todo.size < budget) todo.set(keyOf(g), g);
  const ask = [...todo.values()];
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < ask.length) {
      const g = ask[next++];
      stats.searched++;
      try {
        const opts = (await browser(queryOf(g), { timeout: 60_000 })).flatMap(parseResults);
        cache[keyOf(g)] = { price: opts.length ? Math.min(...opts.map((o) => o.price)) : null, at: new Date(now).toISOString() };
      } catch { stats.failed++; }
    }
  }));
  for (const trip of cells) {
    // Whole trip first: when both win, it's the one that replaces the most.
    for (const g of groupsOf(trip, homes).reverse()) {
      const price = cache[keyOf(g)]?.price;
      if (price == null || g.replace.some((i) => !trip.tickets[i])) continue;
      const sum = g.replace.reduce((s, i) => s + trip.tickets[i].price, 0);
      if (price < sum) { merge(trip, g, price); stats.merged++; break; }
    }
  }
  if (browser) writeJson(file, cache);
  return stats;
}

module.exports = { applyMulti, multiCache, multiSaving, groupsOf, merge, flightAt };
