#!/usr/bin/env node
'use strict';
/* One search, every way we read it: the plain page (what the checks use), the browser's
 * GetShoppingResults, and the cheapest row's sellers. For "Google showed a lower price than ours".
 *   node scraper/bin/fare-probe.js YVR HKG 2027-09-10 2027-09-25 J
 */
const { searchPlain, parseResults } = require('../src/gflights/flights');
const { openBrowser, shoppingResults, bookingOptions } = require('../src/gflights/browser');

const row = (o) => `${String(o.price).padStart(6)}  ${o.legs.map((l) => `${l.code} ${l.from}-${l.to} ${l.depDate} ${l.dep}`).join(' / ')}${o.stops.length ? `  (stops ${o.stops.map((s) => `${s.at} ${Math.round(s.min / 6) / 10}h`).join(', ')})` : ''}`;
const show = (label, opts) => {
  const sorted = opts.slice().sort((a, b) => a.price - b.price);
  console.log(`\n## ${label}: ${sorted.length} rows, cheapest ${sorted[0]?.price ?? '—'}`);
  for (const o of sorted.slice(0, 15)) console.log(row(o));
};

async function main() {
  const [from, to, out, ret, cabin = 'Y'] = process.argv.slice(2);
  const query = { from, to, out, ret: ret === '-' ? null : ret, cabin };
  console.log(`${from}⇄${to} ${cabin} ${out}/${ret} at ${new Date().toISOString()}`);
  try { show('plain page (checks)', await searchPlain(query)); } catch (e) { console.log(`\n## plain page: ${e.message}`); }
  const { browser, ctx } = await openBrowser();
  try {
    try { show('browser GetShoppingResults', (await shoppingResults(ctx, query, { timeout: 60_000 })).flatMap(parseResults)); } catch (e) { console.log(`\n## browser: ${e.message}`); }
    try {
      const { listed, options } = await bookingOptions(ctx, query);
      console.log(`\n## sellers of the cheapest row (listed ${listed})`);
      for (const o of options.sort((a, b) => a.price - b.price)) console.log(`${String(o.price).padStart(6)} ${o.airlineDirect ? 'airline' : 'agency '} ${o.matchesCabin ? '' : '(other cabin) '}${o.sellerName}`);
    } catch (e) { console.log(`\n## sellers: ${e.message}`); }
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
