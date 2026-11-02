/* Trip builder (SCOPE.md: Trip builder and dashboard; Decisions 2026-10-31, coverage).
 *
 * A trip: a long leg home → city X (round trip, or a one-way), any tickets within Asia (economy
 * one-ways, and returns nested inside the trip), a long leg city Y → home. 14-21 days home to home,
 * both long legs in the same cabin, and ≥ 5 nights in Hoi An somewhere along the way, reached
 * overland from a Vietnam anchor city (Da Nang, Hue, Hanoi, Saigon; ground days each way from
 * fares.anchors): in at one anchor, out at any. Ranked by total price, nothing else.
 *
 * The flights in Asia don't depend on the long legs, so for each arrival city X and departure day a
 * forward DP over (day, city, Hoi An done?, open return?) finds the cheapest plan to every (Y, day);
 * each long-leg fare then just adds its price on top. An Asia return A⇄B opens an obligation: be in
 * B on its return day and fly B → A (already paid), staying in B (or Hoi An) until then; closed
 * before flying home.
 *
 * Day 0 is the departure from home; the Pacific crossing lands on day 1 (date line). Hops land the
 * day they leave. A flight on the day the previous ticket lands is a same-day connection: allowed
 * (≥ 4 h, SCOPE) but the price graph has no times, so the trip is marked `sameDay` to verify.
 */

import { samePrice } from './price.js';
import { CITIES, inVietnam } from './cities.js';

const MIN_DAYS = 14;
const MAX_DAYS = 21;
const HOI_AN_NIGHTS = 5;
// Fallbacks per cell, for when the detail pass finds a connection no listed flight makes.
const FALLBACKS = 4;
// Throw-in plans per (end city, day) besides the cheapest (hopPlans): the board's rows by cities
// slept in each get a trip, not only the ones the cheapest plans happen to pass.
const THROUGH = 4;
const PER_CITY = 3; // throughs: each city's cheapest ways kept besides (hopPlans)
const HOLD = 3; // and for this many days after they land

/**
 * How a trip ranks, lower first: its price plus its shape penalties (pen: nights before Hoi An and
 * the hub at both ends, hopPlans; conn: long connections on a ticket, details.js), all
 * together at most the "same price" tolerance (price.js): a pick never costs more than that over
 * the cheapest it beat.
 */
const scoreOf = (t, reentry = true) => (t ? t.total + Math.min(samePrice(t) * t.total, (t.pen ?? 0) + (t.conn ?? 0) + (reentry && t.reentry ? REENTRY : 0)) : Infinity);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// Trip-shape preferences (SCOPE), in dollars added to a plan's score (never its price), so they
// only decide between plans at about the same price (scoreOf caps them at the tolerance):
const PRE_NIGHT = 4; // a night away from Hoi An before it: time elsewhere goes after Hoi An
const BOTH_ENDS = 30; // 2+ nights in the arrival city both before and after Hoi An
const ONE_NIGHT = 25; // flying on after a single night (a ~14 h overnight): 0 nights or 2+ suit better
// Into Vietnam a second time (visas): the whole tolerance, so it only wins clearly cheaper. Scored
// on finished trips only (trip.reentry), not inside the planner nor in a cell's shortlist (keep):
// a trip that one ticket makes far cheaper (build-trips multiSaving) still gets its chance.
const REENTRY = 10000;

/**
 * Best plans within Asia from arrival city `x`, landing day 1 after departure `d0`: the cheapest,
 * or with `prefs` the best by price plus the trip-shape penalties (PRE_NIGHT, BOTH_ENDS,
 * ONE_NIGHT; shapePen scores the same). Returns plans(y, t): the best ways to be in city y on day
 * t, ready to fly home, Hoi An done, no return open and a night in each of `need` (the via filter's
 * cities; staysOf's sense: a night there, or either end of the Hoi An stay); one with a night in x
 * first and one without (different trips, kept both for the builder's choice); without prefs, also
 * up to THROUGH more by way of other cities (throughs: the board's throw-in rows);
 * [{ cost, hops: [{ kind: 'ow'|'rt'|'back'|'stay', from, to, date, ret?, price }] }]
 * ('back' is a nested return's second flight, paid with its 'rt'; 'stay' marks the Hoi An stay).
 */
function hopPlans(x, d0, fares, need = [], prefs = false) {
  const { anchors = { DAD: 0 } } = fares;
  const { hopsFrom, returnsFrom } = indexOf(fares);
  const bit = (c) => (need.includes(c) ? 1 << need.indexOf(c) : 0);
  const all = (1 << need.length) - 1;
  // best[t] maps a state's key (keyOf: a number from city, done, open, seen, xs) → { city, done, open, seen, xs, cost, score, prev: { t, key }, hop }
  // open: an open return (openOf: fly B → A on that day, already paid) or NONE; seen: bits of `need` stayed in;
  // xs: nights in x before Hoi An, 0, 1 or 2 (2+); once 2, nights there after it: 3 after one, and
  // back to 1 with BOTH_ENDS paid after two. run: nights here since landing, 0, 1 or 2 (2+; the
  // Hoi An stay counts as 2). Without prefs, xs is only 0 or 1 and run stays 0.
  const best = Array.from({ length: MAX_DAYS + 1 }, () => new Map());
  // An open return, interned: { id (for the keys), b, a, due }: fly b → a on day due; NONE: none.
  const NONE = { id: 0, due: Infinity };
  const opens = new Map();
  const openOf = (b, a, due) => {
    const k = `${b}>${a}@${due}`;
    let o = opens.get(k);
    if (!o) opens.set(k, (o = { id: opens.size + 1, b, a, due }));
    return o;
  };
  const cityId = new Map(fares.cities.map((c, i) => [c, i]));
  const nc = fares.cities.length;
  const keyOf = (s, seen = s.seen) => (((((s.open.id * nc + cityId.get(s.city)) * 2 + s.done) * 4 + s.xs) * 3 + s.run) * (all + 1)) + seen;
  let today = 0, fresh = null; // states improved on the day being flown, to fly on from again
  const put = (t, s, prev, hop) => {
    if (t > MAX_DAYS || t > s.open.due) return false;
    const key = keyOf(s);
    // Not if a state that has seen as much or more scores as well, or the same state 2+ nights in
    // (it never owes ONE_NIGHT; a key's run part is run * (all + 1)).
    if (best[t].get(key)?.score <= s.score) return false;
    if (s.run < 2 && best[t].get(key + (2 - s.run) * (all + 1))?.score <= s.score) return false;
    for (let m = (s.seen + 1) | s.seen; m <= all; m = (m + 1) | s.seen) if (best[t].get(keyOf(s, m))?.score <= s.score) return false;
    s.prev = prev; // s is always a fresh object (callers build one per move)
    s.hop = hop;
    best[t].set(key, s);
    if (t === today) fresh.add(key);
    return true;
  };
  // Landing at a Vietnam anchor also offers the Hoi An stay: overland there, the nights, overland
  // to any anchor (open jaw); done on the day that leaves.
  const land = (t, s, prev, hop) => {
    const changed = put(t, s, prev, hop);
    if (!s.done && s.city in anchors && best[t].get(keyOf(s))?.score === s.score) {
      for (const [w, g] of Object.entries(anchors)) {
        const days = anchors[s.city] + HOI_AN_NIGHTS + g; // from landing at `city` to flying out of `w`
        put(t + days, { ...s, city: w, done: 1, seen: s.seen | bit(s.city) | bit(w), run: 2 }, { t, key: keyOf(s) }, { kind: 'stay', from: s.city, to: w, need: days });
      }
    }
    return changed;
  };
  land(arrival(x, d0, fares), { city: x, done: 0, open: NONE, seen: 0, xs: 0, run: 0, cost: 0, score: 0 }, null, null);

  for (let t = 1; t <= MAX_DAYS; t++) {
    if (t > 1) { // stay a night
      for (const [key, s] of best[t - 1]) {
        const n = { ...s, seen: s.seen | bit(s.city) };
        if (!prefs) {
          if (!s.done && s.city === x) n.xs = 1;
          put(t, n, { t: t - 1, key }, null);
          continue;
        }
        n.run = Math.min(s.run + 1, 2);
        if (!s.done) { n.score += PRE_NIGHT; if (s.city === x) n.xs = Math.min(s.xs + 1, 2); }
        else if (s.city === x && s.xs >= 2) {
          if (s.xs === 2) n.xs = 3;
          else { n.xs = 1; n.score += BOTH_ENDS; }
        }
        put(t, n, { t: t - 1, key }, null);
      }
    }
    const date = addDays(d0, t);
    // Flights on this day, chained same-day from each state that improved (prices > 0 but a
    // nested return's second flight, which only closes an open return, so this ends).
    today = t;
    for (let todo = [...best[t].keys()]; todo.length;) {
      fresh = new Set();
      for (const key of todo) {
        const s = best[t].get(key);
        const prev = { t, key };
        const fly = (to, price, open = s.open) => ({ city: to, done: s.done, open, seen: s.seen, xs: s.xs, run: 0, cost: s.cost + price, score: s.score + price + (s.run === 1 ? ONE_NIGHT : 0) });
        if (s.open !== NONE) {
          const { b, a, due } = s.open;
          if (s.city === b && due === t) {
            land(t, fly(a, 0, NONE), prev, { kind: 'back', from: b, to: a, date, price: 0 });
          }
          // Until it flies back, stay at its far end (or the Hoi An stay, land): flying on from an
          // open return made every one its own search (75x slower) and never found a cheaper plan.
          continue;
        }
        for (const [to, price] of hopsFrom(s.city, date)) {
          // Lands the next day when every listed flight does (overnight): the night is on the way.
          const late = Math.max(0, fares.lands?.(s.city, to, date) ?? 0);
          land(t + late, fly(to, price), prev, { kind: 'ow', from: s.city, to, date, price, ...(late ? { late } : {}) });
        }
        if (s.open !== NONE) continue;
        for (const [to, ret, price] of returnsFrom(s.city, date)) {
          const due = t + (Date.parse(ret) - Date.parse(date)) / 864e5;
          if (due > MAX_DAYS) continue;
          const hopRt = { kind: 'rt', from: s.city, to, date, ret, price };
          land(t, fly(to, price, openOf(to, s.city, due)), prev, hopRt);
        }
      }
      todo = [...fresh];
    }
  }

  // The flight home leaves the last city too: after one night there, ONE_NIGHT.
  const endOf = (y, t, xs) => [0, 1, 2].map((run) => best[t]?.get(keyOf({ city: y, done: 1, open: NONE, seen: all, xs, run })))
    .filter(Boolean).map((e) => ({ e, score: e.score + (e.run === 1 ? ONE_NIGHT : 0) })).reduce(better, null);
  const better = (a, b) => (!a || (b && b.score < a.score) ? b : a);
  const hopsOf = (end) => {
    const hops = [];
    for (let s = end; s.prev; s = best[s.prev.t].get(s.prev.key)) if (s.hop) hops.push(s.hop);
    return hops.reverse();
  };
  // Throw-ins (the board's rows by cities slept in, setOf): the cheapest way through each city c,
  // Hoi An done and 2+ nights in c, then one hop to y (any nights there). Built on first ask:
  // through.get(y)[t] → [{ cost, c, end, hop }], the THROUGH cheapest, each c once.
  let through = null;
  const throughs = () => {
    through = new Map();
    const doneAt = new Map(); // c → [day → cheapest state there, Hoi An done, nothing open]
    for (let t = 1; t <= MAX_DAYS; t++) {
      for (const s of best[t].values()) {
        if (!s.done || s.open !== NONE || (s.seen | bit(s.city)) !== all || anchors[s.city] === 0) continue;
        const at = doneAt.get(s.city) ?? doneAt.set(s.city, []).get(s.city);
        if (!(at[t]?.score <= s.score)) at[t] = s;
      }
    }
    for (const [c, at] of doneAt) {
      const runs = new Map(); // y → [day → cheapest via c landing by then]
      for (let t2 = 3; t2 <= MAX_DAYS; t2++) {
        const s = at[t2 - 2];
        if (!s) continue;
        const date = addDays(d0, t2);
        for (const [y, price] of hopsFrom(c, date)) {
          const days = runs.get(y) ?? runs.set(y, []).get(y);
          if (!(days[t2]?.cost <= s.cost + price)) days[t2] = { cost: s.cost + price, score: s.score + price, c, end: s, hop: { kind: 'ow', from: c, to: y, date, price } };
        }
      }
      for (const [y, days] of runs) {
        const list = through.get(y) ?? through.set(y, Array.from({ length: MAX_DAYS + 1 }, () => [])).get(y);
        let held = null; // stay on in y: the cheapest landed by day t
        for (let t = 3; t <= MAX_DAYS; t++) {
          if (days[t] && !(held?.cost <= days[t].cost)) held = days[t];
          if (held) list[t].push(held);
        }
      }
    }
    // Each (y, t): the THROUGH cheapest, and each c's PER_CITY cheapest ways into y, held on
    // HOLD days after landing, wherever they rank: a city never among the cheapest still gets a row.
    for (const list of through.values()) {
      const ways = new Map(); // c → Map(way → the day it lands)
      list.forEach((l, t) => l.forEach((p) => {
        const w = ways.get(p.c) ?? ways.set(p.c, new Map()).get(p.c);
        if (!w.has(p)) w.set(p, t);
      }));
      const extra = new Map([...ways.values()].flatMap((w) => [...w].sort(([a], [b]) => a.cost - b.cost).slice(0, PER_CITY)));
      list.forEach((l, t) => {
        l.sort((a, b) => a.cost - b.cost);
        l.splice(THROUGH, Infinity, ...l.slice(THROUGH).filter((p) => t - extra.get(p) <= HOLD));
      });
    }
  };
  return (y, t) => {
    const plans = [endOf(y, t, 0), [1, 2, 3].map((xs) => endOf(y, t, xs)).reduce(better, null)].filter(Boolean)
      .map(({ e: end }) => ({ cost: end.cost, hops: hopsOf(end) }));
    if (prefs) return plans;
    if (!through) throughs();
    return [...plans, ...(through.get(y)?.[t] ?? []).filter((p) => p.c !== x).map((p) => ({ cost: p.cost, hops: [...hopsOf(p.end), p.hop] }))];
  };
}

/**
 * The day (after departure d0, landing day 1 at the earliest) the long flight out lands in x: day 2
 * when every listed flight from every home lands two days on (long connections through the US).
 */
function arrival(x, d0, fares) {
  return 1 + Math.max(0, Math.min(...fares.homes.map((h) => (fares.lands?.(h, x, d0) ?? 1) - 1)));
}

/**
 * A plan's trip-shape penalty (hopPlans with prefs scores the same): PRE_NIGHT per night before
 * Hoi An, ONE_NIGHT per stay of exactly one night (the Hoi An stay and its exit city aside; the
 * last stay too, before the flight home on day t), BOTH_ENDS for 2+ nights in x both before and
 * after Hoi An. x: the arrival city (landed day 1).
 */
function shapePen(x, d0, hops, t) {
  const day = (iso) => (Date.parse(iso) - Date.parse(d0)) / 864e5;
  let at = { city: x, since: 1, done: 0, exit: false }, pen = 0, xBefore = 0, xAfter = 0;
  const leave = (until) => {
    const n = until - at.since;
    if (!at.done) { pen += PRE_NIGHT * n; if (at.city === x) xBefore += n; } else if (at.city === x) xAfter += n;
    if (n === 1 && !at.exit) pen += ONE_NIGHT;
  };
  for (const h of hops) {
    if (h.kind === 'stay') { at = { city: h.to, since: at.since + h.need, done: 1, exit: true }; continue; }
    leave(day(h.date));
    at = { city: h.to, since: day(h.date), done: at.done, exit: false };
  }
  leave(t);
  return pen + (xBefore >= 2 && xAfter >= 2 ? BOTH_ENDS : 0);
}

/** True when a plan flies into Vietnam a second time (REENTRY). x: the arrival city. */
function reentersVietnam(x, hops) {
  let vn = inVietnam(x), entries = +vn;
  for (const h of hops) {
    if (h.kind === 'stay') continue;
    if (inVietnam(h.to) && !vn) entries++;
    vn = inVietnam(h.to);
  }
  return entries > 1;
}

/**
 * The plan's Hoi An stay moved to the nearest anchor with the days for it (Da Nang's nights over
 * Saigon's), when it's in and out of one city; the flights and price stay, only where the nights
 * go changes. x: the arrival city (landed day `start`), t: the day home.
 */
function nearestStay(x, d0, hops, t, anchors = { DAD: 0 }, start = 1) {
  const k = hops.findIndex((h) => h.kind === 'stay');
  if (k < 0 || hops[k].from !== hops[k].to || !anchors[hops[k].from]) return hops;
  const day = (iso) => (Date.parse(iso) - Date.parse(d0)) / 864e5;
  const flights = hops.filter((h) => h.kind !== 'stay');
  let best = null, g = anchors[hops[k].from]; // the nearest so far: ground days each way
  for (let i = 0; i <= flights.length; i++) {
    const c = i ? flights[i - 1].to : x;
    if (!(anchors[c] < g)) continue;
    const need = 2 * anchors[c] + HOI_AN_NIGHTS;
    if ((i < flights.length ? day(flights[i].date) : t) - (i ? day(flights[i - 1].date) + (flights[i - 1].late ?? 0) : start) >= need) { best = { i, c, need }; g = anchors[c]; }
  }
  if (!best) return hops;
  return [...flights.slice(0, best.i), { kind: 'stay', from: best.c, to: best.c, need: best.need }, ...flights.slice(best.i)];
}

/**
 * fares' hops and Asia returns by origin and day: hopsFrom(city, date) → [[to, price]],
 * returnsFrom(city, date) → [[to, ret, price]]. Built once per fares object, on first use.
 */
const INDEX = new WeakMap();
function indexOf(fares) {
  if (INDEX.has(fares)) return INDEX.get(fares);
  const hops = new Map(), rts = new Map();
  const memo = (m, k, make) => (m.has(k) ? m.get(k) : (m.set(k, make()), m.get(k)));
  const { cities, hop } = fares;
  const asiaRT = fares.asiaRT ?? (() => []);
  const index = {
    hopsFrom: (from, date) => memo(hops, `${from}|${date}`, () => cities.flatMap((to) => {
      const p = to === from ? null : hop(from, to, date);
      return p == null ? [] : [[to, p]];
    })),
    returnsFrom: (from, date) => memo(rts, `${from}|${date}`, () => cities.flatMap((to) => (to === from ? [] : asiaRT(from, to, date).map((r) => [to, r.ret, r.price])))),
  };
  INDEX.set(fares, index);
  return index;
}

/** True when any flight leaves on the day the previous ticket lands (times to verify). */
function hasSameDay(d0, hops, backDate) {
  let landed = addDays(d0, 1);
  for (const h of hops.filter((x) => x.kind !== 'stay')) {
    if (h.date === landed) return true;
    landed = h.date;
  }
  return backDate === landed;
}

/**
 * True when no flight leaves on the day the previous one lands, counting the long haul as landing
 * day 1 at the earliest (cheap routings often land day 2): connects whatever the times are, nearly.
 */
function isSafe(d0, hops, backDate) {
  let landed = addDays(d0, 1);
  for (const h of hops.filter((x) => x.kind !== 'stay')) {
    if (h.date <= landed) return false;
    landed = h.date;
  }
  return backDate > landed;
}

/**
 * A trip's tickets and flying order from its long legs and Asia plan, and where the Hoi An stay
 * falls: stay = { after: the order index of the flight landing before it, need: days from that
 * landing to the next flight } (details.js checks it against real times): `first` (a long round trip
 * or one-way), the plan's hops (a nested return's 'back' is the second flight of its 'rt'), and
 * `last` (the one-way home, or null when `first` is a round trip).
 */
function ticketsOf(first, hops, last) {
  const tickets = [first];
  const order = [[0, 'out']];
  const open = [];
  let stay = null;
  for (const h of hops) {
    if (h.kind === 'stay') { stay = { after: order.length - 1, need: h.need }; continue; }
    if (h.kind === 'back') { order.push([open.pop(), 'back']); continue; }
    const { kind, late: _late, ...rest } = h;
    tickets.push({ kind, ...rest, cabin: 'Y' });
    order.push([tickets.length - 1, 'out']);
    if (kind === 'rt') open.push(tickets.length - 1);
  }
  if (last) { tickets.push(last); order.push([tickets.length - 1, 'out']); } else order.push([0, 'back']);
  return { tickets, order, stay };
}

/**
 * Where a trip actually stays: cities with at least a night between landing and the next flight
 * (a long haul lands the day after it leaves). A city only changed planes in doesn't count, so it
 * isn't in the via filter. stays: in first-stayed order; nights: city → nights there (flown in and
 * out of the same city; the Hoi An stay's overland ends aren't split); x, y: where the long flight
 * out lands and the long flight home leaves (the crossing).
 */
function staysOf(trip, homes) {
  const at = (iso) => Date.parse(iso) / 864e5;
  const flights = trip.order.map(([i, dir]) => {
    const t = trip.tickets[i];
    const f = dir === 'back' ? { from: t.to, to: t.from, date: t.ret } : dir.startsWith('leg') ? t.legs[Number(dir.slice(3))] : t;
    const long = homes.includes(f.from) || homes.includes(f.to);
    return { from: f.from, to: f.to, leave: at(f.date), land: at(f.date) + (long ? 1 : 0) };
  });
  const stays = [];
  const nights = {};
  for (let k = 1; k < flights.length; k++) {
    const n = flights[k].leave - flights[k - 1].land;
    if (n < 1) continue;
    for (const c of [flights[k - 1].to, flights[k].from]) if (!stays.includes(c)) stays.push(c);
    if (flights[k - 1].to === flights[k].from) nights[flights[k].from] = (nights[flights[k].from] ?? 0) + n;
  }
  return { stays, nights, x: flights[0].to, y: flights.at(-1).from };
}

/**
 * A row's throw-ins: the cities besides the crossing (x, y) a trip spends 2+ nights in, leaving out
 * Vietnam (Hoi An is in every trip) unless the crossing is Vietnam too and there's nothing else;
 * Hoi An's own anchors never. Codes sorted, "+"-joined; '' for none.
 */
function setOf({ nights, x, y }) {
  const kept = (vn) => Object.keys(nights).filter((c) => nights[c] >= 2 && c !== x && c !== y && inVietnam(c) === vn && CITIES[c]?.vietnam !== 0);
  let set = kept(false);
  if (!set.length && inVietnam(x) && inVietnam(y)) set = kept(true);
  return set.sort().join('+');
}

/** A row's id, for links and the page: "BKK-DPS", "BKK-DPS+HAN+SIN" (in-out+throw-ins). */
const rowId = (r) => `${r.in}-${r.out}${r.set ? `+${r.set}` : ''}`;

/**
 * Every trip worth showing, as the cheapest per (home, class, crossing, throw-ins, departure month):
 * in, out the crossing (staysOf x, y), set the throw-ins (setOf).
 *
 * fares: {
 *   homes, cities,                                  // e.g. ['YVR','YYJ'], ['DAD','ICN',…]
 *   anchors                            → { city: ground days to Hoi An } (Vietnam anchors)
 *   lands(from, to, date)              → days after leaving the earliest flight lands | null (unknown:
 *                                        a hop lands that day, a long flight the next)
 *   roundTrip(from, to, cabin, out)    → [{ ret, price }]   (any trip lengths Google priced)
 *   oneWay(from, to, cabin, date)      → price | null      (long legs, either direction)
 *   hop(from, to, date)                → price | null      (economy within Asia)
 *   asiaRT(from, to, date)             → [{ ret, price }]   (economy returns within Asia)
 *   departures                         → sorted ISO dates to try as day 0
 * }
 * Returns [{ home, cls: 'hybrid'|'economy', in, out, set, month, total, depart, ret, days, sameDay, safe, tickets, order, alts, fallbacks }],
 * tickets: [{ kind: 'rt'|'ow', from, to, date, ret?, cabin, price }]; order: the flights in flying
 * order as [ticket index, 'out'|'back'].
 * fallbacks being the next cheapest trips for the same cell plus the cheapest safe one (isSafe).
 * via: '' for the cell's cheapest overall; a city code for its cheapest that stays in that city
 * (in, out or a hop's destination), for the dashboard's via filter. alts is 0 for those.
 * where alts counts the trip's other date sets (depart, ret) in its month within SIMILAR of its
 * price. The array also carries `.dateSets`: "home|cls|in|out|set" → Map("depart|ret" → cheapest
 * total), for counting across months (similarCount).
 *
 * opts.need: cities every trip must stay in (the page's multi-city via filter; then only via '');
 * opts.homes: a subset of fares.homes.
 */
function buildTrips(fares, { need = [], homes = fares.homes } = {}) {
  const classes = [['hybrid', 'J'], ['economy', 'Y']];
  const top = new Map(); // key → cheapest FALLBACKS + 1 trips, cheapest first
  const safe = new Map(); // key → cheapest safe trip
  const dateSets = new Map();
  // Kept per cell (via ''), and again per cell and city the trip stays in (the via filter).
  const offer = (trip) => {
    const st = staysOf(trip, fares.homes);
    trip.set = setOf(st);
    for (const via of need.length ? [''] : ['', ...st.stays]) keep(trip, via);
    const route = `${trip.home}|${trip.cls}|${trip.in}|${trip.out}|${trip.set}`;
    if (!dateSets.has(route)) dateSets.set(route, new Map());
    const sets = dateSets.get(route), set = `${trip.depart}|${trip.ret}`;
    if (!(sets.get(set) <= trip.total)) sets.set(set, trip.total);
  };
  const keep = (trip, via) => {
    const key = `${trip.home}|${trip.cls}|${trip.in}|${trip.out}|${trip.set}|${trip.month}|${via}`;
    const list = top.get(key) ?? [];
    if (list.length <= FALLBACKS || scoreOf(list.at(-1), false) > scoreOf(trip, false)) {
      const at = list.findIndex((t) => scoreOf(t, false) > scoreOf(trip, false));
      list.splice(at < 0 ? list.length : at, 0, trip);
      if (list.length > FALLBACKS + 1) list.pop();
      top.set(key, list);
    }
    if (trip.safe && !(scoreOf(safe.get(key)) <= scoreOf(trip))) safe.set(key, trip);
  };

  for (const d0 of fares.departures) {
    for (const x of fares.cities) {
      // Only cities a long leg flies to that day.
      if (!homes.some((h) => ['J', 'Y'].some((c) => fares.oneWay(h, x, c, d0) != null || fares.roundTrip(h, x, c, d0).length))) continue;
      // The cheapest plans and the preferred ones: every row keeps the cheapest it has, and a
      // preferred plan at about the same price can beat it (scoreOf).
      const [cheap, pref] = [false, true].map((prefs) => hopPlans(x, d0, fares, need, prefs));
      const plans = new Map(); // "y|t" → the plans, each once (asked again per home and class)
      const plan = (y, t) => {
        const k = `${y}|${t}`;
        if (!plans.has(k)) {
          const sigs = new Set();
          plans.set(k, [...cheap(y, t), ...pref(y, t)].map((p) => ({ ...p, hops: nearestStay(x, d0, p.hops, t, fares.anchors, arrival(x, d0, fares)) })).filter((p) => {
            const sig = p.hops.map((h) => `${h.kind}${h.from}${h.to}${h.date ?? ''}${h.ret ?? ''}`).join();
            if (sigs.has(sig)) return false;
            sigs.add(sig);
            p.pen = shapePen(x, d0, p.hops, t);
            p.reentry = reentersVietnam(x, p.hops);
            return true;
          }));
        }
        return plans.get(k);
      };
      for (const home of homes) {
        for (const [cls, cabin] of classes) {
          const base = { home, cls, in: x, month: d0.slice(0, 7), depart: d0 };
          // Round trip: home on the same ticket, so in = out.
          for (const { ret, price } of fares.roundTrip(home, x, cabin, d0)) {
            const days = (Date.parse(ret) - Date.parse(d0)) / 864e5;
            if (days < MIN_DAYS || days > MAX_DAYS) continue;
            for (const p of plan(x, days)) offer({
              ...base, out: x, total: price + p.cost, pen: p.pen, reentry: p.reentry, ret, days, sameDay: hasSameDay(d0, p.hops, ret), safe: isSafe(d0, p.hops, ret),
              ...ticketsOf({ kind: 'rt', from: home, to: x, date: d0, ret, cabin, price }, p.hops, null),
            });
          }
          // Two one-ways: in and out may differ.
          const outPrice = fares.oneWay(home, x, cabin, d0);
          if (outPrice == null) continue;
          for (let days = MIN_DAYS; days <= MAX_DAYS; days++) {
            const ret = addDays(d0, days);
            for (const y of fares.cities) {
              const backPrice = fares.oneWay(y, home, cabin, ret);
              if (backPrice == null) continue;
              for (const p of plan(y, days)) offer({
                ...base, out: y, total: outPrice + p.cost + backPrice, pen: p.pen, reentry: p.reentry, ret, days, sameDay: hasSameDay(d0, p.hops, ret), safe: isSafe(d0, p.hops, ret),
                ...ticketsOf({ kind: 'ow', from: home, to: x, date: d0, cabin, price: outPrice }, p.hops,
                  { kind: 'ow', from: y, to: home, date: ret, cabin, price: backPrice }),
              });
            }
          }
        }
      }
    }
  }
  // A trip can head several lists (its cell's and its cities'), so each entry is its own copy.
  const trips = [...top].map(([key, list]) => {
    const [first, ...rest] = list.toSorted((a, b) => scoreOf(a) - scoreOf(b)); // REENTRY now counted
    const s = safe.get(key);
    const via = key.slice(key.lastIndexOf('|') + 1);
    return { ...first, via, fallbacks: s && !rest.includes(s) && s !== first ? [...rest, s] : rest };
  }).sort((a, b) => scoreOf(a) - scoreOf(b));
  for (const t of trips) t.alts = t.via ? 0 : similarCount(dateSets, t, t.month);
  trips.dateSets = dateSets;
  return trips;
}

/** Other date sets for trip's route and class (in `month`, or any) priced about the same (price.js). */
function similarCount(dateSets, trip, month = null) {
  let n = 0;
  for (const [set, total] of dateSets.get(`${trip.home}|${trip.cls}|${trip.in}|${trip.out}|${trip.set}`) ?? []) {
    if (set === `${trip.depart}|${trip.ret}` || (month && set.slice(0, 7) !== month)) continue;
    if (total <= trip.total * (1 + samePrice(trip.cls))) n++;
  }
  return n;
}

export { buildTrips, similarCount, scoreOf, hopPlans, ticketsOf, staysOf, setOf, rowId, hasSameDay, isSafe, nearestStay, reentersVietnam, addDays, HOI_AN_NIGHTS };
