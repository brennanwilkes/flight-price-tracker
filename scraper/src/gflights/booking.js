'use strict';
/* A ticket's booking page: every seller's price for its exact flights (GetBookingResults).
 *
 * The results list and the price graph carry Google's cached price; the booking page asks the
 * sellers. In a browser that isn't flagged as automated (real Chrome, browser.js openBrowser) it
 * lists agencies the others never show: YVR⇄HKG J Sep 10-25 2027, PR117/PR318 + PR311/PR116,
 * listed $4,770-4,870, booking page Trip.com $2,785 (11 sellers; flagged: 5 sellers, $4,612),
 * 4 of 4 tries each way, 2026-11-11. The link is built from the flights alone (tfs.js `booking`).
 */
const { buildTfs } = require('./tfs');
const { parseBatchExecute, parseBooking } = require('./batchexecute');
const { profile } = require('./page-stats');
const { CABIN } = require('./tfs');

const PAGE_URL = 'https://www.google.com/travel/flights/booking';
// A page answers in ~4 s (median; p90 ~10 s, the booking runner 2026-11-12); one that hasn't by
// this won't: at 40 s, 143 dead pages (each tried twice) held the runner's 6 pages ~16 of its 43 min.
const WAIT_MS = 15_000;

const seg = (l) => {
  const m = /^([A-Z0-9]{2})(\d+)$/.exec(l.code ?? '');
  return m && { from: l.from, date: l.depDate, to: l.to, airline: m[1], number: m[2] };
};

/** The booking link for a ticket (ticketTable form: kind, from, to, date, ret, cabin, flights). Null if a flight code doesn't parse. */
function bookingUrl(t) {
  const out = (t.flights?.out?.legs ?? []).map(seg);
  const back = (t.flights?.back?.legs ?? []).map(seg);
  if (!out.length || out.some((x) => !x) || back.some((x) => !x) || (t.ret && !back.length)) return null;
  const tfs = buildTfs({ from: t.from, to: t.to, out: t.date, ret: t.ret ?? null, cabin: t.cabin, selected: out, retSelected: t.ret ? back : null, booking: true });
  return `${PAGE_URL}?tfs=${tfs}&hl=en&gl=CA&curr=CAD`;
}

/**
 * The sellers for a ticket: [{ sellerName, airlineDirect, price, matchesCabin, ... }] (parseBooking),
 * cheapest first. Throws if the page gives none within WAIT_MS (a rejected reply is waited out:
 * the page asks again; "something went wrong" pages happen, the caller may try again).
 */
async function bookingSellers(ctx, t) {
  const url = bookingUrl(t);
  if (!url) throw new Error('flight codes unparsed');
  const t0 = Date.now();
  const page = await ctx.newPage();
  const timer = setTimeout(() => page.close().catch(() => {}), WAIT_MS + 30_000);
  // Phases (page-stats.js): open, nav (to DOMContentLoaded), sellers (then to the reply).
  const prof = await profile(page, 'booking', t0);
  prof.mark('open');
  let ok = false;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).finally(() => prof.mark('nav'));
    const until = Date.now() + WAIT_MS;
    let rejected = 0;
    while (Date.now() < until) {
      for (const r of await page.evaluate(() => window.__rpc.splice(0))) {
        if (!r.url.includes('GetBookingResults') || r.text == null) continue;
        const payloads = parseBatchExecute(r.text).filter((p) => p != null);
        if (payloads.length) { ok = true; return payloads.flatMap(parseBooking).filter((o) => o.price != null).sort((a, b) => a.price - b.price); }
        rejected++;
      }
      await page.waitForTimeout(250);
    }
    throw new Error(`booking page: no sellers within ${WAIT_MS} ms (${rejected} rejected)`);
  } finally {
    clearTimeout(timer);
    prof.mark('sellers');
    await prof.done(ok);
    await page.close().catch(() => {});
  }
}

/**
 * A seller's fare is in the ticket's cabin when every flight of 6 h or more is in it or better
 * (cabins: per leg, 1 economy .. 4 first; SCOPE "cabin by flight length"). Shorter flights may be in
 * any cabin: Google's business fares put YYJ-YVR, HKG-BKK and the like in economy, and requiring
 * every leg dropped ~2/3 of business pages unrecorded (2026-11-12, 3:05 pm Vancouver: 1,181
 * checked, ~400 kept). `legs`: the ticket's flights, out then back, with `min`; without them (or a
 * count that doesn't match), every leg. Not parseBooking's matchesCabin (row[24]): Trip.com's
 * all-business YVR⇄ICN fare had it false, 2026-11-11.
 */
const LONG_MIN = 6 * 60;
// A fare without its cabins isn't proven in any: passing those let BudgetAir's $615 YVR-MNL-x
// through as business (listed $892; 2026-11-12).
function inCabin(o, cabin, legs) {
  if (!Array.isArray(o.cabins) || !o.cabins.length) return false;
  const byLength = Array.isArray(legs) && legs.length === o.cabins.length && legs.every((l) => Number.isFinite(l?.min));
  return o.cabins.every((c, i) => c >= CABIN[cabin] || (byLength && legs[i].min < LONG_MIN));
}

/**
 * A fixed booking page whose two views are known (2026-11-12): YVR⇄HKG business Sep 10-25 2027,
 * PR117/PR318 + PR311/PR116. The full view's cheapest is an agency's ~$3,450 (Trip.com, Globehunters;
 * 6-15 sellers), the short one's $4,612 at best (5 sellers). Asked every few minutes, it says which
 * view an IP is getting. By price, not seller count: haleiwa saw 6 sellers and $3,469 at 9:05 pm.
 */
const CANARY_FULL_BELOW = 4000;
const L = (code, from, to, depDate) => ({ code, from, to, depDate });
const CANARY = { kind: 'rt', from: 'YVR', to: 'HKG', date: '2027-09-10', ret: '2027-09-25', cabin: 'J',
  flights: { out: { legs: [L('PR117', 'YVR', 'MNL', '2027-09-10'), L('PR318', 'MNL', 'HKG', '2027-09-12')] }, back: { legs: [L('PR311', 'HKG', 'MNL', '2027-09-25'), L('PR116', 'MNL', 'YVR', '2027-09-26')] } } };

/** The canary's result, one line: "full|short: N sellers, $X Seller", or "failed: why". */
async function canary(sellers) {
  try {
    const got = await sellers(CANARY);
    return `${got[0]?.price < CANARY_FULL_BELOW ? 'full' : 'short'}: ${got.length} sellers, $${got[0]?.price} ${got[0]?.sellerName ?? ''}`.trim();
  } catch (e) { return `failed: ${String(e.message).slice(0, 50)}`; }
}

module.exports = { bookingUrl, bookingSellers, inCabin, canary, CANARY };
