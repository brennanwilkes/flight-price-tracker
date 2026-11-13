'use strict';
/* Booking-page prices: what the sellers ask for a ticket's exact flights (gflights/booking.js).
 *
 * The results list and the price graph carry Google's cached price; the booking page asks every
 * seller, and in an unflagged browser lists agencies the list never shows. 2026-11-11, 39 board
 * tickets: 20 cheaper there (YVR⇄SIN J -29% Trip.com, YVR⇄ICN J -12%, long-haul economy -4 to
 * -7%, hops -4 to -6%), ~3-4 s a page.
 *
 * A booked price is a listing of that itinerary: a search row with the same flights takes it when
 * cheaper (apply), so the listed price, the planner and "priced as listed" all see it. Rows keep
 * their own price in `listedPrice` (the search cache saves that, unapplied: stripped).
 *   key: cabin|outbound flights|return flights, flights "PR117@2027-09-10,PR318@2027-09-12".
 */
const fs = require('node:fs');
const { airportsOf } = require('../../../frontend/app/cities.js');
const { CABIN } = require('../gflights/tfs');

const BOOKING_HOURS = 12; // as old as the graph prices it stands in for (2-48 h); at 6 a ticket not checked again in time fell back to its cached price
// A page without the listed price's offer in any cabin (cheapest seller over LISTED_GONE x the
// listed price) is held as checked this long only, then asked again, and never applied: Google
// showed one runner 5 sellers ($4,612) where a browser saw 15 (Trip.com $3,450), 2026-11-12.
const PARTIAL_HOURS = 3;
const LISTED_GONE = 1.03;
const ALTS = 2; // a long-haul ticket's other outbounds checked with its return, cheapest first
const ALT_WITHIN = 1.4; // ... up to this many times its price

const legsKey = (legs) => legs.map((l) => `${l.code}@${l.depDate}`).join(',');
const selKey = (sel) => sel.map((s) => `${s.airline}${s.number}@${s.date}`).join(',');
const keyOf = (t) => `${t.cabin}|${legsKey(t.flights.out.legs)}|${t.ret ? legsKey(t.flights.back?.legs ?? []) : ''}`;

/** Fresh entries from each file (state/booking.json form: key → { price, seller, at, listed }), newest kept. */
function loadBookings(files, now = Date.now()) {
  const map = new Map();
  for (const f of files) {
    if (!f || !fs.existsSync(f)) continue;
    let o;
    try { o = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    for (const [k, b] of Object.entries(o)) {
      if (now - Date.parse(b.at) >= BOOKING_HOURS * 3600e3) continue;
      // "No seller in its cabin" only stands when judged by flight length (byLength): the 5:05 pm
      // run (2026-11-12) read a queue without lengths and wrote off 1,332 of 1,802 pages.
      if (b.price == null && !b.byLength) continue;
      if (b.partial && now - Date.parse(b.at) >= PARTIAL_HOURS * 3600e3) continue;
      // From before pages were told apart (no seller count `n`): a price off the listed one may be a
      // fare without cabins (BudgetAir's $615 "business") or a page without the listed offer; asked again.
      if (b.n == null && b.price != null && b.listed && Math.abs(b.price - b.listed) > b.listed * (LISTED_GONE - 1)) continue;
      if (!map.has(k) || map.get(k).at < b.at) map.set(k, b);
    }
  }
  return index(map);
}

// By outbound too: a round trip's outbound row (no return chosen) is priced as its cheapest round trip.
function index(map) {
  map.byOut = new Map();
  for (const [k, b] of map) {
    const [cabin, out, back] = k.split('|');
    if (!back || b.price == null || b.partial) continue;
    const ok = `${cabin}|${out}`;
    if (!map.byOut.has(ok) || map.byOut.get(ok).price > b.price) map.byOut.set(ok, b);
  }
  return map;
}

function saveBookings(file, map) {
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries([...map].sort())));
}

/** Rows of the search with key `key` (details.js: JSON of the query, "full " first for a full list), cheaper where booked. In place. */
function applyBookings(map, key, rows) {
  if (!map?.size || !Array.isArray(rows)) return rows;
  const q = JSON.parse(key.replace(/^full /, ''));
  for (const o of rows) {
    if (!o?.legs?.length) continue;
    const b = q.selected ? map.get(`${q.cabin}|${selKey(q.selected)}|${legsKey(o.legs)}`)
      : q.ret ? map.byOut.get(`${q.cabin}|${legsKey(o.legs)}`)
        : map.get(`${q.cabin}|${legsKey(o.legs)}|`);
    const own = o.listedPrice ?? o.price;
    if (b?.price == null || b.partial) continue;
    // Cheaper: taken. Dearer, on these exact flights (one-way, or the return with its outbound
    // chosen): the page showed the listed price only in another cabin (SCOPE: cabin by flight
    // length), so the cabin's own price stands; 403 of 2,612 business pages were so (2026-11-12),
    // e.g. $4,311 listed, $28,813 in business. An outbound row (any return) only takes cheaper.
    if (b.price < own || (!(q.ret && !q.selected) && b.price > own * LISTED_GONE)) { o.listedPrice = own; o.price = b.price; o.seller = b.seller; }
  }
  return rows;
}

/** Rows as searched (for saving): booked prices taken off. Copies. */
const stripBookings = (rows) => rows.map((o) => (o.listedPrice == null ? o : (({ listedPrice, seller, ...r }) => ({ ...r, price: listedPrice }))(o)));

/**
 * Itineraries to check, best first: each shown ticket's own flights (long-haul business, then
 * long-haul economy, cheapest first), then for a long-haul round trip up to ALTS other outbounds from its search with
 * the same return (Trip.com's $2,785 YVR⇄HKG was on the outbound one row over from the board's).
 * `tiers`: lists of tickets (ticketTable form), each taken whole before the next: the board's own
 * cells, then the filters' (length bands, single-flight). In one list the filters' ~8,200 long-haul
 * itineraries came before the board's 1,990 hops, which were never reached (2026-11-12). A plain
 * list is one tier. `rowsOf(query key)`: that search's rows or null. Booked within BOOKING_HOURS: skipped.
 */
function bookingCandidates(tiers, rowsOf, map, homes) {
  const lists = Array.isArray(tiers[0]) ? tiers : [tiers];
  const out = []; const seen = new Set(map.keys());
  const add = (t) => { if (!t.flights?.out?.legs?.length || (t.ret && !t.flights.back?.legs?.length)) return; const k = keyOf(t); if (!seen.has(k)) { seen.add(k); out.push(t); } };
  const long = (t) => homes.includes(t.from) || homes.includes(t.to);
  for (const tickets of lists) {
    const ok = tickets.filter((t) => (t.kind === 'rt' || t.kind === 'ow') && CABIN[t.cabin]);
    // Business first (what the board is for), each cabin's own tickets before their other outbounds.
    for (const cabin of ['J', 'Y']) addLong(ok.filter((t) => long(t) && t.cabin === cabin));
    for (const t of ok.filter((x) => !long(x))) add(t);
  }
  return out;

  // Cheapest first, both homes together: in the trips files' order YVR's came first, and at ~150-300
  // pages a run (2026-11-12, over the VPN) YYJ's business tickets were never reached.
  function addLong(list) {
    const tickets = [...list].sort((a, b) => a.price - b.price);
    for (const t of tickets) add(t);
    for (const t of tickets) {
      if (!t.ret) continue;
      const q = { from: airportsOf(t.from), to: airportsOf(t.to), out: t.date, cabin: t.cabin, ret: t.ret };
      const rows = rowsOf(JSON.stringify(q)) ?? rowsOf(`full ${JSON.stringify(q)}`) ?? [];
      const mine = legsKey(t.flights.out.legs);
      const alts = [...new Map(rows.filter((o) => o.legs?.length && legsKey(o.legs) !== mine && (o.listedPrice ?? o.price) <= t.price * ALT_WITHIN)
        .map((o) => [legsKey(o.legs), o])).values()].sort((a, b) => (a.listedPrice ?? a.price) - (b.listedPrice ?? b.price)).slice(0, ALTS);
      for (const o of alts) add({ ...t, flights: { out: { legs: o.legs }, back: t.flights.back } });
    }
  }
}

/**
 * Check `itins` on their booking pages until `until` (ms), `pages` at once; `sellers(ticket)` →
 * the booking page's sellers (gflights/booking.js bookingSellers). Each result into `map` (the
 * cheapest seller in the ticket's cabin). Returns { checked, cheaper, none (no seller in its cabin), failed, ms }.
 */
async function bookingPass(itins, sellers, map, { until, pages = 4, inCabin, now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z') }) {
  const t0 = Date.now();
  // Telemetry: sellers a page (by count: few looks like the short view), fares without cabins, and
  // why a price came out dearer than listed (mixed: the listed fare is in another cabin; partial:
  // the listed offer isn't on the page at all).
  const s = { checked: 0, cheaper: 0, dearer: 0, mixed: 0, partial: 0, none: 0, noCabins: 0, failed: 0, left: 0, ms: 0, sellers: { '1-5': 0, '6-10': 0, '11+': 0 } };
  let i = 0;
  await Promise.all(Array.from({ length: pages }, async () => {
    while (i < itins.length && Date.now() < until) {
      const t = itins[i++];
      let got = null;
      for (let n = 0; n < 2 && !got && Date.now() < until; n++) got = await sellers(t).catch(() => null);
      if (!got) { s.failed++; continue; }
      s.checked++;
      s.sellers[got.length <= 5 ? '1-5' : got.length <= 10 ? '6-10' : '11+']++;
      s.noCabins += got.filter((o) => !Array.isArray(o.cabins) || !o.cabins.length).length;
      const legs = [...t.flights.out.legs, ...(t.ret ? t.flights.back?.legs ?? [] : [])];
      const best = got.filter((o) => inCabin(o, t.cabin, legs))[0];
      const any = got[0];
      const seen = { n: got.length, any: any?.price ?? null, anySeller: any?.sellerName ?? null };
      // `guess`: a return guessed, not listed with its outbound (trips/ties.js): no listed price to hold the page to.
      if (any && t.price && !t.guess && any.price > t.price * LISTED_GONE) {
        s.partial++;
        map.set(keyOf(t), { price: best?.price ?? null, seller: best?.sellerName ?? null, at: now(), listed: t.price, partial: true, ...seen });
        continue;
      }
      // None in its cabin: kept too (price null, never applied), so the page isn't asked again
      // every run until BOOKING_HOURS.
      // Without flight lengths (a queue saved before they were kept) every leg had to be in the
      // cabin: not kept then, it's asked again once the queue has them.
      if (!best) { s.none++; if (legs.every((l) => Number.isFinite(l?.min))) map.set(keyOf(t), { price: null, seller: null, at: now(), listed: t.price, byLength: true, ...seen }); continue; }
      map.set(keyOf(t), { price: best.price, seller: best.sellerName, at: now(), listed: t.price, ...seen });
      if (best.price < t.price) s.cheaper++;
      else if (!t.guess && best.price > t.price * LISTED_GONE) { s.dearer++; s.mixed++; }
    }
  }));
  s.left = Math.max(0, itins.length - i);
  s.ms = Date.now() - t0;
  index(map);
  return s;
}

/** One line of a pass's telemetry (bookingPass's returned stats). */
const passLine = (s) => `sellers a page ${s.sellers['1-5']} with 1-5, ${s.sellers['6-10']} with 6-10, ${s.sellers['11+']} with 11+; ${s.partial} without the listed offer (held ${PARTIAL_HOURS} h, unapplied), ${s.mixed} dearer in the cabin than the listed fare (listed in another cabin), ${s.noCabins} fares without cabins (not counted)`;

module.exports = { loadBookings, saveBookings, applyBookings, stripBookings, bookingCandidates, bookingPass, passLine, keyOf, BOOKING_HOURS };
