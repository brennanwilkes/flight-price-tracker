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
// Checked while the IP got the short seller list: an IP gets the full list for ~400-450 pages, then
// short until it rests (10:05 pm Vancouver, 2026-11-12, the canary); kept this long, then asked again.
const SHORT_HOURS = 3;
const LISTED_GONE = 1.03;
const GONE_PAGES = 2; // pages running without the listed offer before the page's own price is the ticket's
const GONE_APART_HOURS = 2;
// An expired price kept this long (map.prev), to tell whether a recheck found anything new: how
// often does a booking price move while Google's listed price stays put? (Scheduling rechecks.)
const PREV_HOURS = 48;
const near = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(5, b * 0.01);
const ALTS = 2; // a long-haul ticket's other outbounds checked with its return, cheapest first
const ALT_WITHIN = 1.4; // ... up to this many times its price
// A ticket last booked at its listed price, listed at the same price since: checked again after
// every other due ticket in its tier, until this long after its check. Over 8 runs to 8:05 am Nov
// 17 such rechecks found a cheaper seller 137 times in 1,993 (7%); a first page finds one 1 time in
// 3 (67 of 193). The filters' first 900 a run were 694 such rechecks while 5,347 waited unchecked.
const QUIET_HOURS = 36;
// YYJ's long hauls and the hops booked at the listed price: held this long (bookingPass `primary`).
// A listed-price move still brings one back at once (bookingCandidates known).
const SLOW_HOURS = 36;

const legsKey = (legs) => legs.map((l) => `${l.code}@${l.depDate}`).join(',');
const selKey = (sel) => sel.map((s) => `${s.airline}${s.number}@${s.date}`).join(',');
const keyOf = (t) => `${t.cabin}|${legsKey(t.flights.out.legs)}|${t.ret ? legsKey(t.flights.back?.legs ?? []) : ''}`;

/** Fresh entries from each file (state/booking.json form: key → { price, seller, at, listed }), newest kept. */
function loadBookings(files, now = Date.now()) {
  const map = new Map();
  // Past BOOKING_HOURS, up to PREV_HOURS: not used, kept to compare a recheck with (map.prev; saved with the map).
  const prev = new Map();
  const seen = new Map(), twice = new Set();
  for (const f of files) {
    if (!f || !fs.existsSync(f)) continue;
    let o;
    try { o = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    for (const [k, b] of Object.entries(o)) {
      // Telemetry: the same ticket's page made twice within 2 h (the sweep's pages beside the
      // scrape and the booking runner work the same queue).
      const t = Date.parse(b.at);
      if (seen.has(k) && seen.get(k) !== t && Math.abs(seen.get(k) - t) < 2 * 3600e3 && now - Math.max(seen.get(k), t) < 3 * 3600e3) twice.add(k);
      if (!seen.has(k) || seen.get(k) < t) seen.set(k, t);
      // `hours`: a filter view's ticket booked at its listed price is held longer (bookingPass listedHours).
      // Every expired check is kept in prev (a page without the listed offer, short, or with no
      // seller in its cabin too: users test for those): why a ticket is due again (dueWhy), and how
      // many times running its page lacked the listed offer (partialN). They used to be dropped,
      // so a ticket asked again every 3 h read as never checked.
      const keep = () => { if (now - Date.parse(b.at) < PREV_HOURS * 3600e3 && b.n != null && (!prev.has(k) || prev.get(k).at < b.at)) prev.set(k, b); };
      if (now - Date.parse(b.at) >= (b.hours ?? BOOKING_HOURS) * 3600e3) { keep(); continue; }
      // "No seller in its cabin" only stands when judged by flight length (byLength): the 5:05 pm
      // run (2026-11-12) read a queue without lengths and wrote off 1,332 of 1,802 pages.
      if (b.price == null && !b.byLength) continue;
      if (b.partial && now - Date.parse(b.at) >= PARTIAL_HOURS * 3600e3) { keep(); continue; }
      // Checked while the IP got the short seller list (the canary, gflights/booking.js): asked again sooner.
      if (b.short && now - Date.parse(b.at) >= SHORT_HOURS * 3600e3) { keep(); continue; }
      // From before pages were told apart (no seller count `n`): a price off the listed one may be a
      // fare without cabins (BudgetAir's $615 "business") or a page without the listed offer; asked again.
      if (b.n == null && b.price != null && b.listed && Math.abs(b.price - b.listed) > b.listed * (LISTED_GONE - 1)) continue;
      if (!map.has(k) || map.get(k).at < b.at) map.set(k, b);
    }
  }
  map.prev = prev;
  const out = index(map);
  out.twice = twice.size;
  return out;
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
  const all = new Map(map.prev ?? []);
  for (const [k, b] of map) all.set(k, b);
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries([...all].sort())));
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
function bookingCandidates(tiers, rowsOf, map, homes, now = Date.now()) {
  const lists = Array.isArray(tiers[0]) ? tiers : [tiers];
  const out = []; const seen = new Set();
  let tier = []; let later = []; let alts = [];
  // Past the first tier (the board), other outbounds go after the tier's own tickets, quiet rechecks
  // too: the filters' other outbounds took 534-641 of ~1,150 pages a run and 25-46 booked under
  // their ticket's price (~6%; the own flights' 323-376 cheaper than listed), Nov 18.
  let altsLast = false;
  // Booked within its hours, at the listed price it's queued at: not due. Listed at another price
  // since: due now (a fare moved; a sale shows here first).
  const known = (k, t) => { if (!map.has(k)) return false; const b = map.get(k); return b == null || b.listed == null || near(b.listed, listedOf(t)); };
  // An other outbound whose last page (map.prev, up to PREV_HOURS) had no seller in its cabin or
  // lacked the listed offer, listed at the same price since: not asked again until then. Such
  // retries priced 1 of 249 pages; an own ticket's, ~1 in 5 (4 pm Vancouver, Nov 23).
  const fruitless = (k, t) => { const p = map.prev?.get(k); return !!p && !p.short && (p.price == null || p.partial) && near(p.listed, listedOf(t)); };
  const add = (t) => { if (!t.flights?.out?.legs?.length || (t.ret && !t.flights.back?.legs?.length)) return; const k = keyOf(t); if (!seen.has(k) && !known(k, t) && !(t.alt && fruitless(k, t))) { seen.add(k); (altsLast && t.alt ? alts : quiet(k, t) ? later : tier).push(t); } };
  const long = (t) => homes.includes(t.from) || homes.includes(t.to);
  for (const tickets of lists) {
    const ok = tickets.filter((t) => (t.kind === 'rt' || t.kind === 'ow') && CABIN[t.cabin]);
    // Business first (what the board is for), each cabin's own tickets before their other outbounds.
    // The first home's long hauls (YVR) before the other's (YYJ): Brennan, Nov 17, YYJ and the hops
    // matter less than YVR's long hauls (they are held longer too: bookingPass slowHours).
    for (const home of homes) for (const cabin of ['J', 'Y']) addLong(ok.filter((t) => (t.from === home || t.to === home) && t.cabin === cabin));
    for (const t of ok.filter((x) => !long(x))) add(t);
    out.push(...tier, ...later, ...alts);
    tier = []; later = []; alts = [];
    altsLast = true;
  }
  return out;

  // Its last page (expired, map.prev) had the listed offer at the listed price, on the full list,
  // and the listed price hasn't moved since, within QUIET_HOURS: checked after the rest (QUIET_HOURS).
  function quiet(k, t) {
    const p = map.prev?.get(k);
    if (!p || p.price == null || p.partial || p.gone || p.short || p.listed == null) return false;
    if (now - Date.parse(p.at) >= QUIET_HOURS * 3600e3) return false;
    return p.price >= p.listed - Math.max(5, p.listed * 0.01) && near(p.listed, listedOf(t));
  }

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
      for (const o of alts) add({ ...t, alt: 1, listed: o.listedPrice ?? o.price, flights: { out: { legs: o.legs }, back: t.flights.back } });
    }
  }
}

/**
 * Check `itins` on their booking pages until `until` (ms), `pages` at once; `sellers(ticket)` →
 * the booking page's sellers (gflights/booking.js bookingSellers). Each result into `map` (the
 * cheapest seller in the ticket's cabin). Returns { checked, cheaper, none (no seller in its cabin), failed, ms }.
 * Optional: `gate()` awaited before each page (the runner holds pages while its IP gets the short
 * seller list); `short()` true when the IP's view is short just now (its results kept SHORT_HOURS,
 * not BOOKING_HOURS); `gapMs` between page starts, across all pages (pacing).
 */
async function bookingPass(itins, sellers, map, { until, pages = 4, inCabin, gate = null, short = null, gapMs = 0, listedHours = null, primary = null, hold: holdOf = null, now =() => new Date().toISOString().replace(/\.\d+Z$/, 'Z') }) {
  const t0 = Date.now();
  let next = Date.now();
  const pace = async () => { if (!gapMs) return; const at = Math.max(Date.now(), next); next = at + gapMs; await new Promise((r) => setTimeout(r, at - Date.now())); };
  // Telemetry: sellers a page (by count: few looks like the short view), fares without cabins, and
  // why a price came out dearer than listed (mixed: the listed fare is in another cabin; partial:
  // the listed offer isn't on the page at all).
  const s = { checked: 0, cheaper: 0, dearer: 0, mixed: 0, partial: 0, gone: 0, none: 0, noCabins: 0, short: 0, failed: 0, left: 0, ms: 0, sellers: { '1-5': 0, '6-10': 0, '11+': 0 }, partialBy: {}, retried: {}, again: {}, againHours: [], quietDrop: null, by: {} };
  // Telemetry: the pages a ticket's own flights take beside its other outbounds' (alt), and what
  // each found: an other outbound booked under its ticket's price makes the trip cheaper.
  const by = (t, what) => { const b = (s.by[t.alt ? 'other outbounds' : 'own flights'] ??= { pages: 0 }); b[what] = (b[what] ?? 0) + 1; };
  let i = 0;
  await Promise.all(Array.from({ length: pages }, async () => {
    while (i < itins.length && Date.now() < until) {
      if (gate) await gate();
      if (Date.now() >= until) break;
      await pace();
      const t = itins[i++];
      if (!t) break;
      let got = null;
      for (let n = 0; n < 2 && !got && Date.now() < until; n++) got = await sellers(t).catch(() => null);
      if (!got) { s.failed++; continue; }
      s.checked++;
      by(t, 'pages');
      s.sellers[got.length <= 5 ? '1-5' : got.length <= 10 ? '6-10' : '11+']++;
      s.noCabins += got.filter((o) => !Array.isArray(o.cabins) || !o.cabins.length).length;
      const legs = [...t.flights.out.legs, ...(t.ret ? t.flights.back?.legs ?? [] : [])];
      const best = got.filter((o) => inCabin(o, t.cabin, legs))[0];
      const any = got[0];
      const seen = { n: got.length, any: any?.price ?? null, anySeller: any?.sellerName ?? null, ...(short?.() ? { short: true } : {}) };
      if (seen.short) s.short++;
      const L = listedOf(t);
      // `guess`: a return guessed, not listed with its outbound (trips/ties.js): no listed price to hold the page to.
      const last = map.get(keyOf(t)) ?? map.prev?.get(keyOf(t));
      // Telemetry: what a page asked again after a fruitless one finds (Nov 23: ~140 board and
      // ~1,400 filters pages a run went to these retries; does a retry ever price the ticket?).
      const retry = last && !last.short ? (last.partial ? 'lacked the offer' : last.price == null ? 'no seller' : null) : null;
      const tally = (what) => { if (!retry) return; const r = (s.retried[`${retry} last time, ${t.alt ? 'other outbounds' : 'own flights'}`] ??= {}); r[what] = (r[what] ?? 0) + 1; };
      // `hold(t)`: hours for this ticket whatever its page found (the board's groups, BOARD_HOURS):
      // the "no listed offer, price applied" and "no seller in its cabin" pages too (they kept 12 h,
      // a third of YVR business board tickets over 6 h old at a run's start, Nov 19).
      const own = holdOf?.(t) ?? null;
      const ownHold = own != null && !seen.short ? { hours: own } : {};
      if (any && L && !t.guess && any.price > L * LISTED_GONE) {
        s.partial++;
        by(t, 'without the listed offer');
        tally('lacked it');
        // Telemetry: is it the same tickets every 3 h (times running), a thin page (sellers), and
        // how far over the listed price is the cheapest seller? A ticket whose every page lacks
        // the listed offer never gets a booking price and takes a page every PARTIAL_HOURS.
        // Counted once a page: a second page under GONE_APART_HOURS on (its listed price moved)
        // is the same reading, not another.
        const apart = last && Date.now() - Date.parse(last.at) >= GONE_APART_HOURS * 3600e3;
        const partialN = last?.partial || last?.gone ? (last.partialN ?? 1) + (apart ? 1 : 0) : 1;
        const over = any.price / L - 1;
        for (const w of [`${partialN === 1 ? '1st' : partialN === 2 ? '2nd' : partialN <= 5 ? '3rd-5th' : '6th+'} time running`,
          `${got.length <= 5 ? '1-5' : got.length <= 10 ? '6-10' : '11+'} sellers`,
          `cheapest ${over <= 0.1 ? '3-10%' : over <= 0.3 ? '10-30%' : 'over 30%'} above listed`,
          seen.short ? 'on the short list' : null].filter(Boolean)) s.partialBy[w] = (s.partialBy[w] ?? 0) + 1;
        // GONE_PAGES pages running without it, on the full list, hours apart: no seller has the
        // listed price (Google's list lags: the canary listed ~$3,470 for hours after every seller
        // was at $4,618, Nov 16). The ticket costs what its cheapest seller in the cabin asks:
        // applied (applyBookings: dearer on its exact flights), held BOOKING_HOURS, and back to
        // the listed price the first page that has it.
        if (partialN >= GONE_PAGES && !seen.short && !last?.short && best) {
          s.gone++;
          map.set(keyOf(t), { price: best.price, seller: best.sellerName, at: now(), listed: L, gone: true, partialN, ...seen, ...ownHold });
          continue;
        }
        map.set(keyOf(t), { price: best?.price ?? null, seller: best?.sellerName ?? null, at: now(), listed: L, partial: true, partialN, ...seen });
        continue;
      }
      if (last?.partial || last?.gone) s.partialBy['had the listed offer this time'] = (s.partialBy['had the listed offer this time'] ?? 0) + 1;
      // None in its cabin: kept too (price null, never applied), so the page isn't asked again
      // every run until BOOKING_HOURS.
      // Without flight lengths (a queue saved before they were kept) every leg had to be in the
      // cabin: not kept then, it's asked again once the queue has them.
      tally(!best ? 'no seller' : best.price < L ? 'cheaper than listed' : 'priced');
      if (!best) { s.none++; by(t, 'no seller in its cabin'); if (legs.every((l) => Number.isFinite(l?.min))) map.set(keyOf(t), { price: null, seller: null, at: now(), listed: L, byLength: true, ...seen, ...ownHold }); continue; }
      // Against its last check (fresh, or expired and kept in map.prev): did the listed price move,
      // did the booking price? A drop with the listed price unmoved is a sale only a recheck finds.
      const was = map.get(keyOf(t)) ?? map.prev?.get(keyOf(t));
      if (was && was.price != null && !was.partial && !was.short && !seen.short && was.listed != null) {
        const h = (Date.now() - Date.parse(was.at)) / 3600e3;
        // Split by what the last check found: a discount below the listed price, or the listed fare.
        const k = `${was.price < was.listed - Math.max(5, was.listed * 0.01) ? 'was below listed' : 'was at listed'}: ${near(L, was.listed) ? 'listed same' : 'listed moved'}, ${near(best.price, was.price) ? 'booked same' : best.price < was.price ? 'booked lower' : 'booked higher'}`;
        s.again[k] = (s.again[k] ?? 0) + 1;
        s.againHours.push(h);
        if (near(L, was.listed) && best.price < was.price - Math.max(5, was.price * 0.01)) {
          const drop = was.price - best.price;
          if (!s.quietDrop || drop > s.quietDrop.drop) s.quietDrop = { drop, what: `${keyOf(t)} $${was.price} → $${best.price} (${best.sellerName}) after ${h.toFixed(0)} h, listed $${L}` };
        }
      }
      // `listedHours`: booked at the listed price, held that long (a recheck finds it changed as
      // rarely as 10 in 100 at ~13 h, 2:05 pm Vancouver, 2026-11-13); a discount below it moves
      // more often (22 of 70 dearer) and keeps BOOKING_HOURS. A listed price moving brings it back sooner (bookingCandidates).
      // Not touching the first home (`primary`, YVR): YYJ's long hauls and the hops, held SLOW_HOURS
      // at the listed price (Brennan, Nov 17: they matter less than YVR's long hauls).
      const hours = own ?? (primary && t.from !== primary && t.to !== primary ? Math.max(SLOW_HOURS, listedHours ?? 0) : listedHours);
      const hold = hours && !seen.short && (own != null || near(best.price, L)) ? { hours } : {};
      map.set(keyOf(t), { price: best.price, seller: best.sellerName, at: now(), listed: L, ...seen, ...hold });
      if (best.price < L) { s.cheaper++; by(t, 'cheaper than listed'); }
      if (t.alt && best.price < t.price - Math.max(5, t.price * 0.01)) by(t, "under its ticket's price");
      else if (!t.guess && best.price > L * LISTED_GONE) { s.dearer++; s.mixed++; }
    }
  }));
  s.left = Math.max(0, itins.length - i);
  s.ms = Date.now() - t0;
  index(map);
  return s;
}

/**
 * What Google listed a ticket at, before any booking price was applied: its row's `listedPrice`
 * (applyBookings), the queue's `listed` (build-trips.js slim), else its price. Held to the ticket's
 * price, a page was judged against an earlier booking price: 135 of 282 board pages came out
 * "without the listed offer" with the canary full (11:05 pm Vancouver, 2026-11-12).
 */
function listedOf(t) {
  if (t.listed != null) return t.listed; // the queue's, or an other outbound's own row
  const row = t.ret ? t.flights?.back?.listedPrice ?? t.flights?.out?.listedPrice : t.flights?.out?.listedPrice;
  return row ?? t.price;
}

/** Why a ticket bookingCandidates queued is due (telemetry): from its last check, fresh or kept in map.prev. */
function dueWhy(t, map) {
  const k = keyOf(t);
  if (map.has(k)) return 'listed price moved since its check';
  const p = map.prev?.get(k);
  if (!p) return 'never checked (48 h)';
  if (p.partial) return 'last page lacked the listed offer';
  if (p.short) return 'last checked on the short list';
  if (p.price == null) return 'no seller in its cabin last time';
  if (p.listed != null && p.price >= p.listed - Math.max(5, p.listed * 0.01) && near(p.listed, listedOf(t))) return Date.now() - Date.parse(p.at) < QUIET_HOURS * 3600e3 ? `hold ran out, at listed and unmoved (after the rest until ${QUIET_HOURS} h)` : `hold ran out, at listed and unmoved, ${QUIET_HOURS} h+`;
  return 'hold ran out';
}
/** dueWhy counted over a list, as text. */
const dueLine = (itins, map) => {
  const by = {};
  for (const t of itins) { const w = dueWhy(t, map); by[w] = (by[w] ?? 0) + 1; }
  return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${w}`).join(', ') || 'none';
};

/** One line of a pass's telemetry (bookingPass's returned stats). */
/**
 * The board's tickets held by group (Brennan, Nov 18: a sale only a booking page shows, on the
 * board, is the likeliest place for one; YVR business matters most, then YYJ business): booked,
 * at the listed price or under it, held this long, then due again. `primary`: the first home.
 */
// Half an hour under the cycle: checked ~:20 into a run, due again by that many runs' start.
// The hops keep their own (null: SLOW_HOURS at the listed price).
const BOARD_HOURS = { primary: { J: 2.5, Y: 5.5 }, other: { J: 7.5, Y: 11.5 } };
// The filters' the same way once a second booking runner left time over (Nov 19: filters at 0
// left in most runs, slots 42% idle): YVR's every 6 h, YYJ's 12 h (were 12 h, 24 h at listed).
const FILTER_HOURS = { primary: { J: 5.5, Y: 5.5 }, other: { J: 11.5, Y: 11.5 } };
const boardHold = (homes, table = BOARD_HOURS) => (t) => {
  if (!homes.includes(t.from) && !homes.includes(t.to)) return null;
  return table[t.from === homes[0] || t.to === homes[0] ? 'primary' : 'other'][t.cabin] ?? null;
};

/**
 * Telemetry: how long since each ticket's last booking page, by home and cabin (the hops apart),
 * its own flights only: the chance of catching a sale only a booking page shows within 6 or
 * 12 h is about the share checked within that long.
 */
function freshLine(tickets, map, homes, now = Date.now()) {
  const by = {};
  for (const t of tickets) {
    if (t.alt) continue;
    const home = homes.find((h) => t.from === h || t.to === h);
    const g = home ? `${home} ${t.cabin}` : `hops ${t.cabin}`;
    const b = map.get(keyOf(t)) ?? map.prev?.get(keyOf(t));
    (by[g] ??= []).push(b?.at ? (now - Date.parse(b.at)) / 3600e3 : Infinity);
  }
  const pct = (a, h) => `${Math.round((100 * a.filter((x) => x < h).length) / a.length)}%`;
  return Object.entries(by).sort().map(([g, a]) => {
    a.sort((x, y) => x - y);
    const med = a[Math.floor(a.length / 2)];
    return `${g} ${a.length}: ${pct(a, 3)} under 3 h, ${pct(a, 6)} under 6 h, ${pct(a, 12)} under 12 h, median ${Number.isFinite(med) ? `${med.toFixed(1)} h` : 'none'}, ${a.filter((x) => !Number.isFinite(x)).length} none in ${PREV_HOURS} h`;
  }).join('; ');
}

const passLine = (s) => `sellers a page ${s.sellers['1-5']} with 1-5, ${s.sellers['6-10']} with 6-10, ${s.sellers['11+']} with 11+; ${s.partial} without the listed offer (${s.gone ?? 0} of them the ${GONE_PAGES}nd page running or later on the full list: the page's price applied, held ${BOOKING_HOURS} h; the rest held ${PARTIAL_HOURS} h, unapplied${Object.keys(s.partialBy ?? {}).length ? `: ${Object.entries(s.partialBy).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${w}`).join(', ')}` : ''}),${s.mixed} dearer in the cabin than the listed fare (listed in another cabin), ${s.noCabins} fares without cabins (not counted), ${s.short} checked while the IP got the short list (held ${SHORT_HOURS} h)${retriedLine(s)}${againLine(s)}`;
// Pages asked again after a fruitless one (bookingPass s.retried), by what the last found and what this one did.
const retriedLine = (s) => {
  const e = Object.entries(s.retried ?? {});
  return e.length ? `; asked again: ${e.sort().map(([k, r]) => `${k} ${Object.values(r).reduce((a, b) => a + b, 0)} (${Object.entries(r).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${w}`).join(', ')})`).join('; ')}` : '';
};
// Rechecks against their last check (bookingPass s.again): what scheduling by listed-price moves would miss.
function againLine(s) {
  const n = Object.values(s.again ?? {}).reduce((a, b) => a + b, 0);
  if (!n) return '';
  const h = [...s.againHours].sort((a, b) => a - b)[Math.floor(s.againHours.length / 2)];
  return `; rechecked ${n} (median ${h.toFixed(0)} h on): ${Object.entries(s.again).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ')}${s.quietDrop ? `; biggest drop with the listed price unmoved ${s.quietDrop.what}` : ''}`;
}

module.exports = { loadBookings, saveBookings, applyBookings, stripBookings, bookingCandidates, bookingPass, passLine, dueWhy, dueLine, listedOf, keyOf, boardHold, freshLine, BOARD_HOURS, FILTER_HOURS, BOOKING_HOURS };
