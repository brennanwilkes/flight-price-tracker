#!/usr/bin/env node
'use strict';
/* M1 spike: confirm pass for one date pair.
 *   node scraper/bin/booking-probe.js YVR ICN 2026-12-01 2026-12-15 J
 */
const { openBrowser, bookingOptions } = require('../src/gflights/browser');

async function main() {
  const [from, to, out, ret, cabin = 'Y'] = process.argv.slice(2);
  const { browser, ctx } = await openBrowser();
  const t0 = Date.now();
  try {
    const { listed, options } = await bookingOptions(ctx, { from, to, out, ret, cabin });
    console.log(`${from}⇄${to} ${cabin} ${out}/${ret}: listed ${listed} [${Date.now() - t0}ms]`);
    for (const o of options) {
      console.log(`  ${String(o.price).padStart(6)} ${o.airlineDirect ? 'direct' : 'ota   '} ${o.matchesCabin ? '      ' : 'other cabin'} ${o.sellerName}${o.fare ? ` · ${o.fare}` : ''}`);
    }
    const direct = options.filter((o) => o.airlineDirect && o.matchesCabin && o.price != null);
    console.log(`airline-direct: ${direct.length ? Math.min(...direct.map((o) => o.price)) : 'none'}`);
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
