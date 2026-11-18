/**
 * Telemetry: why the booking queue's tickets change from one build to the next. On Nov 16 the
 * filters' tier took in 3,543 new tickets of 15,275 a build and lost as many, against ~830 booking
 * pages a run, so its never-checked count stayed at ~7,000. This says what the newcomers are (other
 * dates, other flights on the same dates, a ticket's other outbounds), how long tickets stay, how
 * many come back after leaving, and how many pages went to tickets that then left.
 */
const crypto = require('crypto');
const { keyOf } = require('./bookings');

const KEEP_HOURS = 48;
const idOf = (k) => crypto.createHash('sha1').update(k).digest('base64').slice(0, 10);
const slot = (t) => `${t.cabin}|${t.kind}|${t.from}|${t.to}|${t.date}|${t.ret ?? ''}`;
const route = (t) => `${t.cabin}|${t.kind}|${t.from}|${t.to}`;
const legs = (f) => (f?.legs ?? []).map((l) => `${l.code}@${l.depDate}`).join(',');
const tally = (list) => { const m = {}; for (const k of list) m[k] = (m[k] ?? 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'; };
const hours = (h) => (h < 1 ? 'under 1 h' : h < 4 ? '1-3 h' : h < 13 ? '4-12 h' : h < 25 ? '13-24 h' : '25+ h');

/** What a ticket in `mine` and not in `other` (the other build's queue, an index) is against it. */
function kind(t, other, tierName) {
  const k = keyOf(t);
  if (other.tierOf.has(k)) return `in the ${tierName[other.tierOf.get(k)]} tier there`;
  if (t.alt) return other.own.has(slot(t)) ? 'another outbound of a ticket in both' : 'another outbound of a ticket not in both';
  const same = other.own.get(slot(t));
  if (same) {
    const out = same.some((o) => legs(o.flights?.out) === legs(t.flights?.out));
    const back = same.some((o) => legs(o.flights?.back) === legs(t.flights?.back));
    return `same dates, ${out ? 'other return flights' : back ? 'other outbound flights' : 'other flights both ways'}`;
  }
  return other.routes.has(route(t)) ? 'other dates on its route' : 'a route not in the other';
}

/**
 * Why a ticket of the last build's queue (with its `cell` and `cellTotal` then) isn't in this one:
 * `ctx.priceNow` (key → this build's price of that itinerary, any trip planned), `ctx.cellTotal`
 * (cell → its total now). "same prices, its cell picked another" with the cell's total unmoved is a
 * flip between equal trips: the churn that costs pages and searches for nothing.
 */
/** A gone cell's kind (`<view><row>|<class><label>`: label '', ' <month>', ' band <b>', then
 * ' fast <cap>') and whether its row and its class's whole-row cell are still there. */
function cellGone(cell, ctx) {
  const cut = cell.lastIndexOf('|');
  const row = cell.slice(0, cut);
  const rest = cell.slice(cut + 1);
  const sp = rest.indexOf(' ');
  const label = sp < 0 ? '' : rest.slice(sp);
  const kind = / fast \d+$/.test(label) ? `${label.replace(/ fast \d+$/, '') ? (/ band /.test(label) ? 'band' : 'month') + ' ' : ''}long-haul cap` : / band /.test(label) ? 'band' : label ? 'month' : 'whole row';
  if (!ctx.rows) ctx.rows = new Set([...ctx.cellTotal.keys()].map((c) => c.slice(0, c.lastIndexOf('|'))));
  const where = !ctx.rows.has(row) ? 'row gone' : ctx.cellTotal.has(`${row}|${sp < 0 ? rest : rest.slice(0, sp)}`) ? 'row there' : 'row there, not its class';
  return `${kind}, ${where}`;
}

function goneWhy(t, ctx, aIndex, tierName) {
  const k = keyOf(t);
  if (aIndex.tierOf.has(k)) return `to the ${tierName[aIndex.tierOf.get(k)]} tier`;
  if (t.alt) return aIndex.own.has(slot(t)) ? 'other outbound, its ticket still queued' : 'other outbound, its ticket gone too';
  const now = ctx.priceNow.get(k);
  const was = t.price;
  const moved = (a, b) => Math.abs(a - b) > Math.max(5, b * 0.01);
  if (now == null) {
    // Planned trips are mostly cells' picks, so a ticket its cell dropped is usually unplanned too:
    // say what its cell did.
    if (t.cell == null) return 'not planned now, cell not known';
    const total = ctx.cellTotal.get(t.cell);
    const tol = Math.max(5, (t.cellTotal ?? 0) * 0.01);
    if (total == null) return `not planned now, its cell gone (${cellGone(t.cell, ctx)})`;
    if (total < t.cellTotal - tol) return 'not planned now, its cell found a cheaper trip';
    if (total > t.cellTotal + tol) return 'not planned now, its cell dearer now (its flights gone or up)';
    return `not planned now, its cell the same total with another trip (a flip${flipBy(total, t.cellTotal)})`;
  }
  if (moved(now, was)) {
    if (now < was) return 'cheaper now, still not picked';
    return t.listed != null && was < t.listed - Math.max(5, t.listed * 0.01) ? 'dearer now (was below listed: booking price gone or up)' : 'dearer now (listed up)';
  }
  if (t.cell == null) return 'same price, cell not known';
  const total = ctx.cellTotal.get(t.cell);
  if (total == null) return 'same price, its cell gone';
  if (total < t.cellTotal - Math.max(5, t.cellTotal * 0.01)) return 'same price, its cell found a cheaper trip';
  if (total > t.cellTotal + Math.max(5, t.cellTotal * 0.01)) return 'same price, its cell dearer now (another part of its trip moved)';
  return `same price, its cell the same total with another trip (a flip${flipBy(total, t.cellTotal)})`;
}

// A flip's cell total against its last: to the dollar (a tie a sticky pick would keep), cheaper or
// dearer by under 1% (a real, small move: the cheaper trip must win).
const flipBy = (now, was) => (was == null ? '' : Math.round(now) === Math.round(was) ? ', to the dollar' : now < was ? ', under 1% cheaper' : ', under 1% dearer');

function index(tiers) {
  const tierOf = new Map(); const own = new Map(); const routes = new Set();
  tiers.forEach((l, i) => {
    for (const t of l ?? []) {
      tierOf.set(keyOf(t), i);
      routes.add(route(t));
      if (!t.alt) { const s = slot(t); if (!own.has(s)) own.set(s, []); own.get(s).push(t); }
    }
  });
  return { tierOf, own, routes };
}

/**
 * `now`, `was`: this build's and the last build's tiers (lists of tickets, bookings.js form, `alt`
 * on a ticket's other outbounds). `seen`: { id: [hour first in this stay, hour last queued, stays] }
 * from the last build (kept in the queue's file), hours since the epoch. `checked(key)`: has a
 * booking page in 48 h. Returns { lines, seen } with `seen` brought up to this build.
 */
function turnover(now, was, seen, checked, at = Date.now(), names = ['board', "filters'"], ctx = null) {
  const H = Math.round(at / 360e3) / 10;
  const a = index(now); const b = index(was);
  const next = {};
  for (const [id, v] of Object.entries(seen ?? {})) if (H - v[1] < KEEP_HOURS) next[id] = v;
  const lines = [];
  const started = !seen || !Object.keys(seen).length;
  now.forEach((l, i) => {
    const added = []; const back = []; const ages = {}; const unchecked = {};
    const keys = new Set();
    for (const t of l) {
      const k = keyOf(t);
      if (keys.has(k)) continue;
      keys.add(k);
      const id = idOf(k); const v = next[id];
      if (b.tierOf.get(k) !== i) added.push(t);
      if (!b.tierOf.has(k)) {
        if (v) back.push(H - v[1]);
        next[id] = [H, H, (v?.[2] ?? 0) + 1];
      } else next[id] = [v?.[0] ?? H, H, v?.[2] ?? 1];
      const age = hours(H - next[id][0]);
      ages[age] = (ages[age] ?? 0) + 1;
      if (!checked(k)) unchecked[age] = (unchecked[age] ?? 0) + 1;
    }
    const gone = (was[i] ?? []).filter((t) => a.tierOf.get(keyOf(t)) !== i);
    const stays = gone.map((t) => { const v = (seen ?? {})[idOf(keyOf(t))]; return !v ? 'unknown' : v[1] - v[0] < 0.5 ? 'one build' : hours(v[1] - v[0]); });
    const goneChecked = gone.filter((t) => checked(keyOf(t))).length;
    const cabins = (list) => `${list.filter((t) => t.cabin === 'J').length} business, ${list.filter((t) => t.alt).length} other outbounds`;
    lines.push(`booking queue turnover, ${names[i]} new (${added.length} of ${keys.size}; ${cabins(added)}): ${tally(added.map((t) => kind(t, b, names)))}; ${back.length} were queued before in ${KEEP_HOURS} h (away ${tally(back.map(hours))})${started ? '; first build counting stays' : ''}`);
    lines.push(`booking queue turnover, ${names[i]} gone (${gone.length} of ${(was[i] ?? []).length}; ${cabins(gone)}): ${tally(gone.map((t) => kind(t, a, names)))}; stayed ${tally(stays)}; ${goneChecked} had a booking page in ${KEEP_HOURS} h`);
    if (ctx) {
      const why = gone.map((t) => goneWhy(t, ctx, a, names));
      const paged = gone.filter((t, j) => checked(keyOf(t)) && why[j].includes('flip')).length;
      lines.push(`booking queue turnover, ${names[i]} gone, why: ${tally(why)}; ${paged} of the flips had a booking page in ${KEEP_HOURS} h`);
    }
    lines.push(`booking queue turnover, ${names[i]} by time queued: ${['under 1 h', '1-3 h', '4-12 h', '13-24 h', '25+ h'].filter((h) => ages[h]).map((h) => `${h} ${ages[h]} (${unchecked[h] ?? 0} not checked in ${KEEP_HOURS} h)`).join(', ') || 'none'}`);
  });
  return { lines, seen: next };
}

module.exports = { turnover };
