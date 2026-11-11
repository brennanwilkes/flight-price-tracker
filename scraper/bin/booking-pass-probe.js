#!/usr/bin/env node
'use strict';
/* Scale of the booking-page gap: for tickets from a build's ticketTable, the booking page's
 * cheapest seller vs the ticket's price on the board.
 *   node scraper/bin/booking-pass-probe.js trips-YVR.json [count=30] [pages=3]
 */
const fs = require('node:fs');
const { openBrowser } = require('../src/gflights/browser');
const { bookingSellers, inCabin } = require('../src/gflights/booking');

const HOMES = new Set(['YVR', 'YYJ']);

(async () => {
  const [file, count = 30, pages = 3] = process.argv.slice(2);
  const all = JSON.parse(fs.readFileSync(file, 'utf8')).ticketTable;
  const long = all.filter((t) => HOMES.has(t.from) || HOMES.has(t.to));
  const short = all.filter((t) => !HOMES.has(t.from) && !HOMES.has(t.to));
  const pick = [...long.slice(0, Math.ceil(count * 0.75)), ...short.slice(0, Math.floor(count * 0.25))];
  const { browser, ctx } = await openBrowser();
  const rows = [];
  try {
    let i = 0;
    await Promise.all(Array.from({ length: Number(pages) }, async () => {
      while (i < pick.length) {
        const t = pick[i++];
        const t0 = Date.now();
        let sellers = null; let err = null;
        for (let n = 0; n < 2 && !sellers; n++) sellers = await bookingSellers(ctx, t).catch((e) => { err = e.message; return null; });
        const ok = sellers?.filter((o) => inCabin(o, t.cabin)) ?? [];
        rows.push({ t, best: ok[0], all: sellers?.length ?? 0, err: sellers ? null : err, s: Math.round((Date.now() - t0) / 1000) });
      }
    }));
  } finally { await browser.close(); }
  let cheaper = 0; let n = 0;
  for (const { t, best, all: k, err, s } of rows) {
    const name = `${t.from}${t.ret ? '⇄' : '→'}${t.to} ${t.cabin} ${t.date}${t.ret ? `/${t.ret}` : ''}`;
    if (err) { console.log(`${name.padEnd(36)} ${String(t.price).padStart(6)}  error ${err.slice(0, 60)} (${s}s)`); continue; }
    n++;
    const d = best ? best.price - t.price : null;
    if (d != null && d < 0) cheaper++;
    console.log(`${name.padEnd(36)} ${String(t.price).padStart(6)} → ${String(best?.price ?? '—').padStart(6)} ${d != null && d < 0 ? `${Math.round(-d / t.price * 100)}% less` : ''.padEnd(8)} ${best?.sellerName ?? ''} (${k} sellers, ${s}s)`);
  }
  console.log(`\n${cheaper} of ${n} tickets cheaper on the booking page`);
})();
