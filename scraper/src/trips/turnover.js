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
function turnover(now, was, seen, checked, at = Date.now(), names = ['board', "filters'"]) {
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
    lines.push(`booking queue turnover, ${names[i]} by time queued: ${['under 1 h', '1-3 h', '4-12 h', '13-24 h', '25+ h'].filter((h) => ages[h]).map((h) => `${h} ${ages[h]} (${unchecked[h] ?? 0} not checked in ${KEEP_HOURS} h)`).join(', ') || 'none'}`);
  });
  return { lines, seen: next };
}

module.exports = { turnover };
