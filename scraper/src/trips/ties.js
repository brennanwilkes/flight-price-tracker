'use strict';
/* Date pairs the board never checks (the booking runner: bin/booking-runner.js).
 *
 * The board picks each cell's dates by the price graph and checks the booking page only for
 * those. The graph prices dozens of a route's date pairs the same (YVR⇄HKG business: Sep 1-16,
 * 1-17, 1-19 ... 10-25 all $4,870, 2026-11-12), and an agency's fare can be on any of them
 * (Trip.com $2,785 on Sep 10-25, 2026-11-11, never checked). So every long-haul round trip on the
 * graph gets its flights searched and its booking page checked, cheapest against its route first,
 * and the price found goes to the planner as a listed price (state/checked.json form, merged by
 * the build: --booking-checked), so a date the graph prices too high can win its cell.
 */
const fs = require('node:fs');
const path = require('node:path');
const { fareKey } = require('./fares');

const SEEN_HOURS = 48; // a graph price older than this isn't planned with either
// A date pair tried with nothing proven below the graph: tried again after this long, or at once
// when its graph price drops (a sale shows on the graph first). At 12 h, 5,460 pairs were due
// against ~126 a run (2:05 pm Vancouver, 2026-11-13).
const TRIED_HOURS = 72;

/**
 * Round trips home⇄city in `cabins` from the graph (routes/<from>-<to>-<cabin>/current.json),
 * as tickets, each route's cheapest first and routes interleaved by price over their cheapest
 * (ratio), skipping fares in `skip` (a Set of fareKeys, or ticket → true to skip).
 */
function graphTickets(dataDir, homes, { cabins = ['J'], skip = new Set(), now = Date.now() } = {}) {
  const dir = path.join(dataDir, 'routes');
  const out = [];
  for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const [from, to, cabin, ow] = id.split('-');
    if (ow || !homes.includes(from) || !cabins.includes(cabin)) continue;
    let cur;
    try { cur = JSON.parse(fs.readFileSync(path.join(dir, id, 'current.json'), 'utf8')); } catch { continue; }
    const fresh = Object.entries(cur).filter(([, c]) => c.price != null && c.ret && now - Date.parse(c.seen) < SEEN_HOURS * 3600e3);
    if (!fresh.length) continue;
    const min = Math.min(...fresh.map(([, c]) => c.price));
    for (const [k, c] of fresh) {
      const t = { kind: 'rt', from, to, cabin, date: k.split('|')[0], ret: c.ret, price: c.price };
      if (!(typeof skip === 'function' ? skip(t) : skip.has(fareKey(t)))) out.push({ t, r: c.price / min });
    }
  }
  return out.sort((a, b) => cabins.indexOf(a.t.cabin) - cabins.indexOf(b.t.cabin) || a.r - b.r || a.t.price - b.t.price).map((x) => x.t);
}

/**
 * The cheapest price a fare's booking pages proved: its own itinerary's and its other outbounds'
 * (each with the return guessed from the one-way list home: the page prices that exact pair).
 * Partial pages don't count. null: nothing proven.
 */
function provenPrice(t, itins, map, keyOf) {
  let p = null;
  for (const a of [t, ...itins]) {
    if (fareKey(a) !== fareKey(t)) continue;
    const x = map.get(keyOf(a));
    if (x && !x.partial && x.price != null && (p == null || x.price < p)) p = x.price;
  }
  return p;
}

/**
 * Flights for `list` (graphTickets) until `until` (ms), CHUNK date pairs at a time, as one-ticket
 * trips (details.js addDetails; `browser`: query → GetShoppingResults payload). The return is the
 * one guessed from the one-way list home (`guess`): its booking page prices that exact pair or
 * lists no one. Returns { itins (each pair's ticket and up to ALTS other outbounds, `tie`: its
 * fareKey, `graph`: the graph's price), tried (fareKeys searched, no flights both ways) }.
 * Done on the sweep's runner, beside the scrape: searches don't need the full seller list, and
 * the booking runner's IP keeps its pages for booking pages (2026-11-12).
 */
async function searchTies(list, { browser, until, bookings, homes, chunk = 40, pages = 3 }) {
  const { addDetails, returnsDone } = require('./details');
  const { bookingCandidates } = require('./bookings');
  const itins = []; const tried = [];
  const cache = new Map();
  for (let i = 0; i < list.length && Date.now() < until - 60e3; i += chunk) {
    const trips = list.slice(i, i + chunk).map((t) => ({ tickets: [{ ...t }], order: [[0, 'out'], [0, 'back']] }));
    await addDetails(trips, cache, browser, null, until - 30e3, { pages });
    returnsDone(cache, new Set());
    const rows = new Map();
    for (const [k, p] of cache) { const v = await Promise.race([p, new Promise((r) => setTimeout(r, 0, null))]); if (Array.isArray(v)) rows.set(k, v); }
    for (const tr of trips) {
      const t = tr.tickets[0];
      const tie = fareKey(t);
      if (!(t.flights?.out?.legs?.length && !t.flights.out.miss && t.flights.back?.legs?.length && !t.flights.back.miss)) { if (Date.now() < until - 30e3) tried.push(tie); continue; }
      const graph = t.graph ?? t.price;
      for (const x of bookingCandidates([t], (k) => rows.get(k) ?? null, bookings, homes)) itins.push({ ...x, guess: true, tie, graph });
    }
  }
  return { itins, tried };
}

module.exports = { graphTickets, provenPrice, searchTies, TRIED_HOURS };
