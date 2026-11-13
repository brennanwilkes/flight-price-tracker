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
 * Booking pages only: an IP gets the full seller list for a few hundred pages an hour (the canary,
 * 2026-11-12), so this runner's go to booking pages and the sweep's runner does the searching.
 * In turn, while time is left:
 *  1. the board's itineraries from the last build's queue (tier 0);
 *  2. date pairs the board never checks (trips/ties.js), their flights searched beside the last
 *     scrape (the queue's `ties`), at most TIES_MS; prices found below the graph go to --checked
 *     (state/checked.json form) for the next build's planner;
 *  3. the rest of the queue (the filters').
 * Known prices: the data branch's state/booking.json and the last run's --extra (this job's, saved
 * in the Actions cache: the build that merges it into booking.json runs before it's done). Writes
 * --extra with everything still fresh, for the next run's build and this job.
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadBookings, saveBookings, bookingCandidates, bookingPass, passLine, listedOf, keyOf, BOOKING_HOURS } = require('../src/trips/bookings');
const { useBookings } = require('../src/trips/details');
const { provenPrice } = require('../src/trips/ties');
const { fareKey } = require('../src/trips/fares');
const { inCabin, canary } = require('../src/gflights/booking');
const { openBrowserThread } = require('../src/gflights/browser-thread');

const TIES_MS = 15 * 60e3; // the unchecked date pairs' share of a run, after the board
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
  let tieQueue = { itins: [], tried: [] };
  try { const q = JSON.parse(fs.readFileSync(arg('queue'), 'utf8')); tiers = Array.isArray(q) ? [q] : q.tiers ?? []; if (q.ties) tieQueue = q.ties; } catch {}
  const all = bookingCandidates(tiers, () => null, bookings, homes);
  const nBoard = tiers.length > 1 ? bookingCandidates([tiers[0]], () => null, bookings, homes).length : all.length;
  console.log(`booking runner: ${bookings.size} prices under the age limit, ${tiers.map((l) => l.length).join(' + ')} queued, ${all.length} to check (${nBoard} the board's)`);

  const egress = await fetch('https://api.ipify.org').then((r) => r.text()).catch(() => '?');
  const b = await openBrowserThread({ lean: true });
  // The canary (gflights/booking.js) at the start and with each window: which seller list this IP gets.
  let view = await canary((t) => b.bookingSellers(t));
  console.log(`booking runner: exit IP ${egress}; canary ${view}`);
  // Page times, and progress every 5 min: at 0.70 a second (5:05 pm, 2026-11-12) it ran at half
  // the build pass's 1.45, on the same kind of runner.
  const ms = []; let bad = 0; const t0 = Date.now(); let phase = 'board'; const why = {};
  const q = (p) => { const v = [...ms].sort((x, y) => x - y); return v.length ? Math.round(v[Math.floor(p * (v.length - 1))] / 100) / 10 : '-'; };
  // An IP gets the full seller list for ~400-450 pages, then short until it rests (10:05 pm
  // Vancouver, 2026-11-12: full for 15 min, rejected from 20, short by 35; full again an hour on).
  // So pages are held while the canary isn't full (asked every 2 min), what's checked meanwhile in
  // the ties' searches is marked short, and pages are paced (--gap ms between starts: is it the rate?).
  const isFull = () => view.startsWith('full');
  let held = 0; let holdFrom = null; // wall-clock time held (the pages wait together)
  // A short reading is asked again 30 s on before pages are held: single short readings came and went
  // within a check (11:05 pm Vancouver, 2026-11-12: 3 of them, and 14 min held).
  const ask = () => canary((t) => b.bookingSellers(t));
  const watch = setInterval(async () => {
    let v = await ask();
    if (!v.startsWith('full') && isFull()) {
      await sleep(30e3); v = await ask();
      // Short twice: the same page in a new session (no cookies from this one), same IP. Full there
      // means Google limits the session, not the IP (the IP's ~650 full pages an hour, 2026-11-13).
      if (!v.startsWith('full')) console.log(`  ${Math.round((Date.now() - t0) / 60e3)} min: canary short in this session; in a new session on the same IP: ${await canary((t) => b.freshSellers(t))}`);
    }
    if (v !== view) console.log(`  ${Math.round((Date.now() - t0) / 60e3)} min: canary ${v}`);
    view = v;
  }, 2 * 60e3);
  const gate = async () => {
    while (!isFull() && Date.now() < until) { holdFrom ??= Date.now(); await sleep(15e3); }
    if (holdFrom != null) { held += Date.now() - holdFrom; holdFrom = null; }
  };
  const gapMs = Number(arg('gap', 0));
  const tick = setInterval(() => { console.log(`  ${Math.round((Date.now() - t0) / 60e3)} min (${phase}): ${ms.length} booking pages (${bad} errors), ${(ms.length / ((Date.now() - t0) / 1000)).toFixed(2)} a second, page ${q(0.5)} s median, ${q(0.9)} s p90; this window: ${win.long} long-haul pages, ${win.wide} with 6+ sellers, ${win.gone} without the listed offer, ${win.errors} errors; canary ${view}; held ${Math.round(held / 60e3)} min so far`); win = { long: 0, wide: 0, gone: 0, errors: 0 }; }, 5 * 60e3);
  // Per 5-min window, long-haul pages only (hops list few sellers anyway): how many had 6+ sellers,
  // and how many lacked the listed offer. Does the short seller list come on as an IP's pages pile
  // up? (7:05 pm Vancouver, 2026-11-12: errors 0 in the first 5 min, 246 by 40; 2,362 of 2,859
  // pages had 1-5 sellers; haleiwa saw 5 at 5:50 pm and 10 at 8:05 pm on the same page.)
  let win = { long: 0, wide: 0, gone: 0, errors: 0 };
  const timed0 = async (t) => { const t1 = Date.now(); try { const r = await b.bookingSellers(t); ms.push(Date.now() - t1);
    if (homes.includes(t.from) || homes.includes(t.to)) { win.long++; if (r.length >= 6) win.wide++; if (!t.guess && listedOf(t) && r[0] && r[0].price > listedOf(t) * 1.03) win.gone++; }
    return r; } catch (e) { bad++; win.errors++; ms.push(Date.now() - t1); const w = String(e.message).replace(/\d+/g, 'N').slice(0, 60); why[w] = (why[w] ?? 0) + 1; throw e; } };
  const timed = timed0;
  const pass = async (name, itins, end) => {
    if (!itins.length || Date.now() >= end) return;
    const s = await bookingPass(itins, timed, bookings, { until: end, pages, inCabin, gate, short: () => !isFull(), gapMs });
    console.log(`booking runner, ${name}: ${s.checked} of ${itins.length} checked, ${s.cheaper} cheaper than listed, ${s.none} with no seller in its cabin, ${s.failed} failed, ${s.left} left; ${Math.round(s.ms / 1000)} s (${(s.checked / Math.max(1, s.ms / 1000)).toFixed(2)} a second)`);
    console.log(`booking runner, ${name}: ${passLine(s)}`);
  };
  try {
    await pass('board', all.slice(0, nBoard), until);
    phase = 'unchecked dates';
    await ties(Math.min(until, Date.now() + TIES_MS));
    phase = 'filters';
    await pass('filters', all.slice(nBoard).filter((t) => !bookings.has(keyOf(t))), until);
  } finally { clearInterval(tick); clearInterval(watch); await b.close(); }
  console.log(`booking runner: pages held ${Math.round(held / 60e3)} min for the short list; canary at the end ${view}`);
  console.log(`booking runner: page errors by kind: ${Object.entries(why).sort((x, y) => y[1] - x[1]).map(([w, n]) => `${n}× ${w}`).join('; ') || 'none'}`);
  saveBookings(extra, bookings);
  if (checkedFile) fs.writeFileSync(checkedFile, JSON.stringify(checked));

  // 2. Date pairs the board never checks: their flights searched beside the scrape on the sweep's
  // runner (trips/ties.js searchTies, the queue's `ties`), their booking pages here.
  async function ties(end) {
    const at0 = stamp();
    for (const k of tieQueue.tried ?? []) checked[k] ??= { price: null, at: at0 };
    const byTie = new Map();
    for (const t of tieQueue.itins ?? []) { if (checked[t.tie]) continue; if (!byTie.has(t.tie)) byTie.set(t.tie, []); byTie.get(t.tie).push(t); }
    const st = { searched: byTie.size, flown: byTie.size, pages: 0, proven: 0, cheaper: 0, best: null, unpriced: 0, above: 0, ratios: [] };
    const list = [...byTie.keys()];
    if (!list.length || Date.now() > end - 60e3) { console.log(`booking runner, unchecked dates: ${list.length} date pairs with flights queued`); return; }
    const itins = [...byTie.values()].flat().filter((t) => !bookings.has(keyOf(t)));
    const s = await bookingPass(itins, timed, bookings, { until: end, pages, inCabin, gate, short: () => !isFull(), gapMs });
    st.pages += s.checked;
    for (const [tie, group] of byTie) {
      const t = group[0];
      // Not reached, or checked on the short list (agency fares missing): left for the next run.
      if (!group.every((x) => bookings.has(keyOf(x))) || group.some((x) => bookings.get(keyOf(x)).short)) continue;
      {
        const at = stamp();
        const p = provenPrice(t, group, bookings, keyOf);
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
    console.log(`booking runner, unchecked dates: ${list.length} date pairs with flights queued (searched beside the last scrape), ${itins.length} itineraries; ${st.pages} booking pages, ${st.proven} proven below the graph, ${st.above} at or above it, ${st.unpriced} with no price in the cabin (failed, partial or none)${st.ratios.length ? `; booked/graph median ${st.ratios.sort((x, y) => x - y)[Math.floor(st.ratios.length / 2)].toFixed(2)}` : ''}${st.best ? `; most: ${st.best.what}` : ''}`);
  }
})().catch((e) => { console.error(`booking runner: ${e.stack}`); process.exit(1); });
