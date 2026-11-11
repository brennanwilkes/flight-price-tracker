#!/usr/bin/env node
'use strict';
/* How much does a browser that says it's automated miss? Per search: the plain page's cheapest
 * (the checks), and from a flagged and an unflagged browser the results' cheapest and the price
 * graph's cell for that date. Searches: "O|D|cabin|out[|ret]" keys (state/checked.json's form).
 *   node scraper/bin/flagged-probe.js keys.txt
 */
const fs = require('node:fs');
const { searchPlain, parseResults } = require('../src/gflights/flights');
const { openBrowser, shoppingResults, priceGraph } = require('../src/gflights/browser');

const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const min = (rows) => rows.reduce((m, o) => Math.min(m, o.price), Infinity);
const fmt = (n) => (n == null || n === Infinity ? '—' : String(n)).padStart(6);

async function measure(ctx, q) {
  const shop = await shoppingResults(ctx, q, { timeout: 60_000 }).then((p) => min(p.flatMap(parseResults))).catch(() => null);
  const graph = await priceGraph(ctx, { ...q, tripLen: q.ret ? days(q.out, q.ret) : null, start: q.out, end: q.out })
    .then((cells) => cells.find((c) => c.out === q.out)?.price ?? null).catch(() => null);
  return { shop, graph };
}

(async () => {
  const keys = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
  const qs = keys.map((k) => { const [from, to, cabin, out, ret = null] = k.split('|'); return { key: k, from, to, cabin, out, ret }; });
  const res = new Map(qs.map((q) => [q.key, {}]));
  for (const q of qs) res.get(q.key).plain = await searchPlain(q).then(min).catch(() => null);
  for (const flagged of [true, false]) {
    const { browser, ctx } = await openBrowser({ flagged });
    try {
      for (const q of qs) Object.assign(res.get(q.key), Object.fromEntries(Object.entries(await measure(ctx, q)).map(([k, v]) => [`${flagged ? 'f' : 'u'}${k}`, v])));
    } finally { await browser.close(); }
  }
  console.log(`${'search'.padEnd(30)} ${'plain'.padStart(6)} ${'f-shop'.padStart(6)} ${'u-shop'.padStart(6)} ${'f-grph'.padStart(6)} ${'u-grph'.padStart(6)}  unflagged saves`);
  for (const q of qs) {
    const r = res.get(q.key);
    const best = Math.min(r.ushop ?? Infinity, r.ugraph ?? Infinity);
    const was = Math.min(r.plain ?? Infinity, r.fshop ?? Infinity, r.fgraph ?? Infinity);
    console.log(`${q.key.padEnd(30)} ${fmt(r.plain)} ${fmt(r.fshop)} ${fmt(r.ushop)} ${fmt(r.fgraph)} ${fmt(r.ugraph)}  ${best < Infinity && was < Infinity ? `${Math.round((1 - best / was) * 100)}%` : '?'}`);
  }
})();
