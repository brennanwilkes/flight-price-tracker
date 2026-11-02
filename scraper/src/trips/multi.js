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
 *   - self-transfer: two one-way tickets in one cabin whose flights connect within SELF_HOURS
 *     (your bags, your risk) as one ticket; it wins at about the same price (price.js), not only cheaper
 * A grouping that's cheaper than the tickets it replaces becomes one ticket:
 *   { kind: 'multi', from, to, date, legs: [{ from, to, date }], cabin, price, url, flights: { leg0, … } }
 * and the trip's order refers to its flights as [i, 'leg<k>'].
 */
const path = require('node:path');
const { readJson, writeJson } = require('../store/routes');
const { parseResults } = require('../gflights/flights');
const { pageUrl } = require('../gflights/page');
const { airportsOf, isLong, isPacific } = require('../../../frontend/app/cities.js');
const { samePrice } = require('../../../frontend/app/price.js');

const MAX_AGE_MS = 24 * 3600e3;
const CONCURRENCY = 6;
const SELF_HOURS = 12;
// What a self-transfer costs a trip in the ranking (details.js adds it to conn): about half the
// "same price" tolerance of a typical trip, so a connection on one ticket wins at about the same price.
const SELF_PEN = 40;

const minutes = (date, hm) => Date.parse(`${date}T${hm}:00Z`) / 60000; // local clock: one city's only
/** Minutes between flight a landing and flight b leaving (the same city), or null when either isn't known. */
function gap(a, b) {
  if (!a?.legs?.length || !b?.legs?.length) return null;
  return minutes(b.legs[0].depDate, b.legs[0].dep) - minutes(a.legs.at(-1).arrDate, a.legs.at(-1).arr);
}
/** The self-transfers of a checked trip: [[order index of the flight in, of the flight out]]. */
function selfTransfers(trip) {
  const out = [];
  for (let k = 1; k < (trip.order?.length ?? 0); k++) {
    const [[i, di], [j, dj]] = [trip.order[k - 1], trip.order[k]];
    if (i === j) continue;
    const g = gap(trip.tickets[i].flights?.[di], trip.tickets[j].flights?.[dj]);
    if (g != null && g < SELF_HOURS * 60) out.push([k - 1, k]);
  }
  return out;
}

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
  // Self-transfers first: tried last (applyMulti), a grouping replacing more tickets wins.
  for (const [a, b] of selfTransfers(trip)) {
    const [i, j] = [trip.order[a][0], trip.order[b][0]];
    const [ti, tj] = [trip.tickets[i], trip.tickets[j]];
    if (ti.kind !== 'ow' || tj.kind !== 'ow' || ti.cabin !== tj.cabin) continue;
    out.push({ replace: [i, j], legs: [flightAt(trip, trip.order[a]), flightAt(trip, trip.order[b])], cabin: ti.cabin, self: true });
  }
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

/** One ticket at `price` takes the place of `sum`: cheaper, or for a self-transfer about the same. */
const wins = (g, price, sum) => price < sum || (g.self && price <= sum * (1 + samePrice(g.cabin)));

/** What one ticket would save `trip` in the ranking, by the cached prices only (a real search's, never an estimate): ≥ 0. */
function multiSaving(cache, trip, homes) {
  let best = 0;
  for (const g of groupsOf(trip, homes)) {
    const price = cache[keyOf(g)]?.price;
    if (price == null || g.replace.some((i) => !trip.tickets[i])) continue;
    const sum = g.replace.reduce((s, i) => s + trip.tickets[i].price, 0);
    if (wins(g, price, sum)) best = Math.max(best, sum - price + (g.self ? SELF_PEN : 0));
  }
  return best;
}

/**
 * Price groupings for `cells` (shown trips, most promising first) and merge the cheaper ones.
 * `browser(query, opts)` → GetShoppingResults payloads (null: cached results only). Returns stats.
 */
async function applyMulti(dataDir, cells, homes, browser, { budget = 80, selfBudget = 30, now = Date.now() } = {}) {
  const file = path.join(dataDir, 'state', 'multi.json');
  const cache = multiCache(dataDir, now);
  const stats = { searched: 0, failed: 0, merged: 0 };
  const todo = new Map(); // key → grouping, in the cells' order
  const selfs = new Map(); // self-transfers: a budget of their own
  if (browser) {
    for (const trip of cells) {
      for (const g of groupsOf(trip, homes)) {
        const [into, max] = g.self ? [selfs, selfBudget] : [todo, budget];
        if (!(keyOf(g) in cache) && into.size < max) into.set(keyOf(g), g);
      }
    }
  }
  const ask = [...todo.values(), ...[...selfs.values()].filter((g) => !todo.has(keyOf(g)))];
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
      if (wins(g, price, sum)) { merge(trip, g, price); stats.merged++; if (g.self) stats.self = (stats.self ?? 0) + 1; break; }
    }
  }
  if (browser) writeJson(file, cache);
  return stats;
}

module.exports = { applyMulti, multiCache, multiSaving, groupsOf, merge, flightAt, selfTransfers, SELF_HOURS, SELF_PEN };
