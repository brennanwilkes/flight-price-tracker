'use strict';
/* Deal alerts (SCOPE.md: Alerts). A deal is a long-haul pair: home, class, in, out; its board rows
 * with throw-ins (out "SIN+KUL") are one deal, the cheapest of them pushed. Per row, one sale on
 * one pair took every push a run (2026-11-13: 44 deals in the ledger, 5 pairs).
 *
 * A cell is a deal when its trip connects (checked against real flights) and any of:
 *   buy        it's in the top price tier
 *   cheap-j    business, and its long flights cost under cheapBusinessLongLegs
 *   new-low    below every total recorded for it since lowsSince, once it has newLowWarmupDays of history
 * One push per deal; it pushes again only after a further drop of realertDrop, or a better tier.
 * Thresholds: config/alerts.json.
 */
const fs = require('node:fs');
const path = require('node:path');
const { keyOf } = require('../trips/history');

const TIER_RANK = { '': 0, good: 1, great: 2, buy: 3 };
/** A cell or history key ("home,cls,in,out[+set]") as its long-haul pair's: "home,cls,in,out". */
const pairOf = (key) => key.replace(/\+[^,]*$/, '');

/** The tier word for a total, or ''. */
const tierOf = (config, cls, total) => config.tiers[cls].find(([max]) => total <= max)?.[1] ?? '';

/**
 * Each long-haul pair's lowest total (over its rows with throw-ins) and first sighting in
 * [since, before), from derived/history/*.csv. Map "home,cls,in,out" → { low, first }.
 */
function lows(dataDir, since, before) {
  const out = new Map();
  const dir = path.join(dataDir, 'derived', 'history');
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.csv')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').slice(1)) {
      const [when, home, cls, inn, out_, total] = line.split(',');
      if (when < since || when >= before || total === '') continue;
      const key = pairOf(`${home},${cls},${inn},${out_}`);
      const cur = out.get(key);
      if (!cur) out.set(key, { low: Number(total), first: when });
      else { cur.low = Math.min(cur.low, Number(total)); if (when < cur.first) cur.first = when; }
    }
  }
  return out;
}

/**
 * Deals among the current cells. rows: { home: [row] } as in derived/trips-<HOME>.json; history:
 * lows() before this run (so this run's total isn't its own low). now: ISO.
 * Returns [{ key, home, cls, in, out, set, trip, tier, reasons, prevLow }].
 */
function findDeals(config, rows, history, now) {
  const best = new Map(); // pair → its cheapest row's deal
  const warm = Date.parse(now) - config.newLowWarmupDays * 864e5;
  for (const [home, list] of Object.entries(rows)) {
    for (const r of list) {
      for (const cls of ['hybrid', 'economy']) {
        const trip = r[cls];
        if (!trip || trip.connects !== true) continue;
        const key = pairOf(keyOf({ home, cls, ...r }));
        if (best.has(key) && best.get(key).trip.total <= trip.total) continue;
        const tier = tierOf(config, cls, trip.total);
        const reasons = [];
        if (tier === 'buy') reasons.push('buy');
        const longJ = trip.tickets.filter((t) => t.cabin === 'J').reduce((s, t) => s + t.price, 0);
        if (cls === 'hybrid' && longJ && longJ < config.cheapBusinessLongLegs) reasons.push('cheap-j');
        const h = history.get(key);
        if (h && Date.parse(h.first) <= warm && trip.total < h.low) reasons.push('new-low');
        // A cheaper row of the pair that isn't a deal still stands for it (no push for a dearer row).
        best.set(key, { key, home, cls, in: r.in, out: r.out, set: r.set, trip, tier, reasons, prevLow: h?.low ?? null });
      }
    }
  }
  const deals = [...best.values()].filter((d) => d.reasons.length);
  return deals.sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || a.trip.total - b.trip.total);
}

/** Whether a deal is news against the ledger entry for it ({ total, tier, at } or undefined). */
function isNews(config, deal, prior) {
  if (!prior) return true;
  const drop = Math.max(config.realertDrop.cad, prior.total * config.realertDrop.share);
  return deal.trip.total <= prior.total - drop || TIER_RANK[deal.tier] > TIER_RANK[prior.tier ?? ''];
}

module.exports = { tierOf, lows, findDeals, isNews, pairOf, TIER_RANK };
