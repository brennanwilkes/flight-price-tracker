#!/usr/bin/env node
'use strict';
/* Booking pages on a runner of their own (sweep.yml job `booking`, beside the sweep in the same run).
 * The sweep's runner managed ~1,180 pages a run (2026-11-12): CPU-bound at ~1-1.3 a second, about
 * half that beside the scrape; the queue (~15,900 itineraries, each good for BOOKING_HOURS) needs
 * ~1,325. This runner has the whole of its CPU for them.
 *
 *   node scraper/bin/booking-runner.js --data <data snapshot> --queue .booking-queue.json
 *     --extra .booking-extra.json --checked .booking-checked.json --until <epoch s> [--pages 6]
 *
 * In turn, while time is left:
 *  1. the board's itineraries from the last build's queue (tier 0);
 *  2. date pairs the board never checks (trips/ties.js): business round trips off the graph, their
 *     flights searched and their booking pages checked, at most TIES_MS; the prices found go to
 *     --checked (state/checked.json form) for the next build's planner;
 *  3. the rest of the queue (the filters'), from the front; the pass beside the scrape takes it
 *     from the back (build-trips.js), so the two don't check the same pages.
 * Known prices: the data branch's state/booking.json and the last run's --extra (this job's, saved
 * in the Actions cache: the build that merges it into booking.json runs before it's done). Writes
 * --extra with everything still fresh, for the next run's build and this job.
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadBookings, saveBookings, bookingCandidates, bookingPass, passLine, keyOf, BOOKING_HOURS } = require('../src/trips/bookings');
const { addDetails, returnsDone, useBookings } = require('../src/trips/details');
const { graphTickets, provenPrice } = require('../src/trips/ties');
const { fareKey } = require('../src/trips/fares');
const { inCabin } = require('../src/gflights/booking');
const { openBrowserThread } = require('../src/gflights/browser-thread');

const TIES_MS = 15 * 60e3; // the unchecked date pairs' share of a run, after the board
const TIE_CHUNK = 40; // date pairs searched, then booked, at a time
const TIE_HOURS = BOOKING_HOURS; // a date pair checked is left this long

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

(async () => {
  const dataDir = arg('data');
  const extra = arg('extra');
  const checkedFile = arg('checked');
  const until = Number(arg('until')) * 1000;
  const pages = Number(arg('pages', 6));
  const homes = require('../config/sweep.json').origins;
  const bookings = loadBookings([path.join(dataDir, 'state', 'booking.json'), extra]);
  useBookings(bookings);
  let checked = {};
  try { checked = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(checkedFile, 'utf8'))).filter(([, c]) => Date.now() - Date.parse(c.at) < TIE_HOURS * 3600e3)); } catch {}
  let tiers = [];
  try { const q = JSON.parse(fs.readFileSync(arg('queue'), 'utf8')); tiers = Array.isArray(q) ? [q] : q.tiers ?? []; } catch {}
  const all = bookingCandidates(tiers, () => null, bookings, homes);
  const nBoard = tiers.length > 1 ? bookingCandidates([tiers[0]], () => null, bookings, homes).length : all.length;
  console.log(`booking runner: ${bookings.size} prices under the age limit, ${tiers.map((l) => l.length).join(' + ')} queued, ${all.length} to check (${nBoard} the board's)`);

  const b = await openBrowserThread({ lean: true });
  // Page times, and progress every 5 min: at 0.70 a second (5:05 pm, 2026-11-12) it ran at half
  // the build pass's 1.45, on the same kind of runner.
  const ms = []; let bad = 0; const t0 = Date.now(); let phase = 'board'; const why = {};
  const q = (p) => { const v = [...ms].sort((x, y) => x - y); return v.length ? Math.round(v[Math.floor(p * (v.length - 1))] / 100) / 10 : '-'; };
  const tick = setInterval(() => { console.log(`  ${Math.round((Date.now() - t0) / 60e3)} min (${phase}): ${ms.length} booking pages (${bad} errors), ${(ms.length / ((Date.now() - t0) / 1000)).toFixed(2)} a second, page ${q(0.5)} s median, ${q(0.9)} s p90; this window: ${win.long} long-haul pages, ${win.wide} with 6+ sellers, ${win.gone} without the listed offer, ${win.errors} errors`); win = { long: 0, wide: 0, gone: 0, errors: 0 }; }, 5 * 60e3);
  // Per 5-min window, long-haul pages only (hops list few sellers anyway): how many had 6+ sellers,
  // and how many lacked the listed offer. Does the short seller list come on as an IP's pages pile
  // up? (7:05 pm Vancouver, 2026-11-12: errors 0 in the first 5 min, 246 by 40; 2,362 of 2,859
  // pages had 1-5 sellers; haleiwa saw 5 at 5:50 pm and 10 at 8:05 pm on the same page.)
  let win = { long: 0, wide: 0, gone: 0, errors: 0 };
  const timed0 = async (t) => { const t1 = Date.now(); try { const r = await b.bookingSellers(t); ms.push(Date.now() - t1);
    if (homes.includes(t.from) || homes.includes(t.to)) { win.long++; if (r.length >= 6) win.wide++; if (!t.guess && t.price && r[0] && r[0].price > t.price * 1.03) win.gone++; }
    return r; } catch (e) { bad++; win.errors++; ms.push(Date.now() - t1); const w = String(e.message).replace(/\d+/g, 'N').slice(0, 60); why[w] = (why[w] ?? 0) + 1; throw e; } };
  const timed = timed0;
  const pass = async (name, itins, end) => {
    if (!itins.length || Date.now() >= end) return;
    const s = await bookingPass(itins, timed, bookings, { until: end, pages, inCabin });
    console.log(`booking runner, ${name}: ${s.checked} of ${itins.length} checked, ${s.cheaper} cheaper than listed, ${s.none} with no seller in its cabin, ${s.failed} failed, ${s.left} left; ${Math.round(s.ms / 1000)} s (${(s.checked / Math.max(1, s.ms / 1000)).toFixed(2)} a second)`);
    console.log(`booking runner, ${name}: ${passLine(s)}`);
  };
  try {
    await pass('board', all.slice(0, nBoard), until);
    phase = 'unchecked dates';
    await ties(Math.min(until, Date.now() + TIES_MS));
    phase = 'filters';
    await pass('filters', all.slice(nBoard).filter((t) => !bookings.has(keyOf(t))), until);
  } finally { clearInterval(tick); await b.close(); }
  console.log(`booking runner: page errors by kind: ${Object.entries(why).sort((x, y) => y[1] - x[1]).map(([w, n]) => `${n}× ${w}`).join('; ') || 'none'}`);
  saveBookings(extra, bookings);
  if (checkedFile) fs.writeFileSync(checkedFile, JSON.stringify(checked));

  // 2. Date pairs the board never checks: searched as one-ticket trips, then their booking pages.
  async function ties(end) {
    if (Date.now() > end - 3 * 60e3) return;
    const queued = new Set(tiers.flat().filter((t) => t.kind === 'rt').map(fareKey));
    const list = graphTickets(dataDir, homes, { skip: new Set([...queued, ...Object.keys(checked)]) });
    const st = { searched: 0, flown: 0, pages: 0, proven: 0, cheaper: 0, best: null, unpriced: 0, above: 0, ratios: [] };
    const cache = new Map();
    const browser = (qq, opts) => b.shoppingResults(qq, opts);
    for (let i = 0; i < list.length && Date.now() < end - 3 * 60e3; i += TIE_CHUNK) {
      const trips = list.slice(i, i + TIE_CHUNK).map((t) => ({ tickets: [{ ...t }], order: [[0, 'out'], [0, 'back']] }));
      const searchEnd = Math.min(end - 2 * 60e3, Date.now() + 6 * 60e3);
      await addDetails(trips, cache, browser, null, searchEnd, { pages: 3 });
      returnsDone(cache, new Set()); // the return guessed from the one-way list home is what's asked: its booking page prices that pair or lists no one
      st.searched += trips.length;
      const tix = trips.map((tr) => tr.tickets[0]).filter((t) => t.flights?.out?.legs?.length && !t.flights.out.miss && t.flights.back?.legs?.length && !t.flights.back.miss);
      for (const t of tix) t.guess = true;
      st.flown += tix.length;
      const rows = new Map();
      for (const [k, p] of cache) { const v = await Promise.race([p, sleep(0).then(() => null)]); if (Array.isArray(v)) rows.set(k, v); }
      const itins = bookingCandidates(tix, (k) => rows.get(k) ?? null, bookings, homes);
      const s = itins.length ? await bookingPass(itins, timed, bookings, { until: end, pages, inCabin }) : { checked: 0 };
      st.pages += s.checked;
      for (const tr of trips) {
        const t = tr.tickets[0];
        const at = stamp();
        const p = tix.includes(t) ? provenPrice(t, itins, bookings, keyOf) : null;
        // Tried, nothing proven (no flights, or no seller in its cabin): not tried again for TIE_HOURS; never planned with.
        const was = t.graph ?? t.price;
        // Only a price below the graph's goes to the planner: one above may be the short seller
        // list (no listed price to hold a guessed pair to), and the graph's then stands.
        if (p == null) st.unpriced++; else st.ratios.push(p / was);
        if (p != null && p >= was) st.above++;
        if (p == null || p >= was) { checked[fareKey(t)] = { price: null, at }; continue; }
        st.proven++;
        if (p < was) { st.cheaper++; if (!st.best || was - p > st.best.save) st.best = { save: was - p, what: `${t.from}⇄${t.to} ${t.cabin} ${t.date}/${t.ret} graph $${was} → $${p}${bookings.get(keyOf(t))?.seller ? ` (${bookings.get(keyOf(t)).seller})` : ''}` }; }
        checked[fareKey(t)] = { price: p, at, searched: at };
      }
    }
    console.log(`booking runner, unchecked dates: ${list.length} business round trips on the graph not on the board's queue or checked in ${TIE_HOURS} h; ${st.searched} searched, ${st.flown} with flights both ways, ${st.pages} booking pages, ${st.proven} proven below the graph, ${st.above} at or above it, ${st.unpriced} with no price in the cabin (failed, partial or none)${st.ratios.length ? `; booked/graph median ${st.ratios.sort((x, y) => x - y)[Math.floor(st.ratios.length / 2)].toFixed(2)}` : ''}${st.best ? `; most: ${st.best.what}` : ''}`);
  }
})().catch((e) => { console.error(`booking runner: ${e.stack}`); process.exit(1); });
