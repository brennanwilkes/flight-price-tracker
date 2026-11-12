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
const { loadBookings, saveBookings, bookingCandidates, bookingPass } = require('../src/trips/bookings');
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
      const s = await bookingPass(itins, (t) => b.bookingSellers(t), bookings, { until, pages, inCabin });
      console.log(`booking runner: ${s.checked} of ${itins.length} checked, ${s.cheaper} cheaper than listed, ${s.none} with no seller in its cabin, ${s.failed} failed, ${s.left} left; ${Math.round(s.ms / 1000)} s (${(s.checked / (s.ms / 1000)).toFixed(2)} a second)`);
    } finally { await b.close(); }
  }
  saveBookings(extra, bookings);
})().catch((e) => { console.error(`booking runner: ${e.stack}`); process.exit(1); });
