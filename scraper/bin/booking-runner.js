#!/usr/bin/env node
'use strict';
/* Booking pages on a runner of their own (sweep.yml job `booking`, beside the sweep in the same run).
 * The sweep's runner managed ~1,180 pages a run (2026-11-12): CPU-bound at ~1-1.3 a second, about
 * half that beside the scrape; the queue (~15,900 itineraries, each good for BOOKING_HOURS) needs
 * ~1,325. This runner has the whole of its CPU for them.
 *
 *   node scraper/bin/booking-runner.js --data <data snapshot> --queue .booking-queue.json
 *     --extra .booking-extra.json --until <epoch s> [--pages 6]
 *
 * Takes the last build's queue (board first, then the filters') from the front; the pass beside
 * the scrape takes it from the back (build-trips.js), so the two don't check the same pages.
 * Known prices: the data branch's state/booking.json and the last run's --extra (this job's, saved
 * in the Actions cache: the build that merges it into booking.json runs before it's done). Writes
 * --extra with everything still fresh, for the next run's build and this job.
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadBookings, saveBookings, bookingCandidates, bookingPass, passLine } = require('../src/trips/bookings');
const { inCabin } = require('../src/gflights/booking');
const { openBrowserThread } = require('../src/gflights/browser-thread');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };

(async () => {
  const dataDir = arg('data');
  const extra = arg('extra');
  const until = Number(arg('until')) * 1000;
  const pages = Number(arg('pages', 6));
  const homes = require('../config/sweep.json').origins;
  const bookings = loadBookings([path.join(dataDir, 'state', 'booking.json'), extra]);
  let tiers = [];
  try { const q = JSON.parse(fs.readFileSync(arg('queue'), 'utf8')); tiers = Array.isArray(q) ? [q] : q.tiers ?? []; } catch {}
  const itins = bookingCandidates(tiers, () => null, bookings, homes);
  console.log(`booking runner: ${bookings.size} prices under the age limit, ${tiers.map((l) => l.length).join(' + ')} queued, ${itins.length} to check`);
  if (itins.length && Date.now() < until) {
    const b = await openBrowserThread({ lean: true });
    try {
      // Page times, and progress every 5 min: at 0.70 a second (5:05 pm, 2026-11-12) it ran at half
      // the build pass's 1.45, on the same kind of runner.
      const ms = []; let bad = 0; const t0 = Date.now();
      const q = (p) => { const v = [...ms].sort((x, y) => x - y); return v.length ? Math.round(v[Math.floor(p * (v.length - 1))] / 100) / 10 : '-'; };
      const tick = setInterval(() => console.log(`  ${Math.round((Date.now() - t0) / 60e3)} min: ${ms.length} pages (${bad} errors), ${(ms.length / ((Date.now() - t0) / 1000)).toFixed(2)} a second, page ${q(0.5)} s median, ${q(0.9)} s p90`), 5 * 60e3);
      const timed = async (t) => { const t1 = Date.now(); try { const r = await b.bookingSellers(t); ms.push(Date.now() - t1); return r; } catch (e) { bad++; ms.push(Date.now() - t1); throw e; } };
      const s = await bookingPass(itins, timed, bookings, { until, pages, inCabin }).finally(() => clearInterval(tick));
      console.log(`booking runner: ${s.checked} of ${itins.length} checked, ${s.cheaper} cheaper than listed, ${s.none} with no seller in its cabin, ${s.failed} failed, ${s.left} left; ${Math.round(s.ms / 1000)} s (${(s.checked / (s.ms / 1000)).toFixed(2)} a second)`);
      console.log(`booking runner: ${passLine(s)}`);
    } finally { await b.close(); }
  }
  saveBookings(extra, bookings);
})().catch((e) => { console.error(`booking runner: ${e.stack}`); process.exit(1); });
