#!/usr/bin/env node
'use strict';
/* Does visiting an agency's checkout page first change the sellers Google lists on a booking page?
 * 2026-11-11, by hand (signed-out tab, VPN): BudgetAir's checkout page, then the Google booking page
 * for YVR⇄HKG J Sep 10-25 PR117/PR318 + PR311/PR116 showed Trip.com $2,785 (fresh tab: $4,612).
 *   node scraper/bin/booking-trigger-probe.js
 */
const { openBrowser } = require('../src/gflights/browser');
const { parseBatchExecute, parseBooking } = require('../src/gflights/batchexecute');

const BOOKING = 'https://www.google.com/travel/flights/booking?tfs=CBwQAhpgEgoyMDI3LTA5LTEwIh8KA1lWUhIKMjAyNy0wOS0xMBoDTU5MKgJQUjIDMTE3Ih8KA01OTBIKMjAyNy0wOS0xMhoDSEtHKgJQUjIDMzE4agcIARIDWVZScgcIARIDSEtHGmASCjIwMjctMDktMjUiHwoDSEtHEgoyMDI3LTA5LTI1GgNNTkwqAlBSMgMzMTEiHwoDTU5MEgoyMDI3LTA5LTI2GgNZVlIqAlBSMgMxMTZqBwgBEgNIS0dyBwgBEgNZVlJAAUgDcAGCAQsI____________AZgBAQ&tfu=CnRDalJJUzA1WlNHRnFRbXB3VkVsQlJXTXpiMUZDUnkwdExTMHRMUzB0Y0dwaWJIY3hOMEZCUVVGQlIzSXdjblkwUW1SNFEyRkJFZ3RRVWpNeE1YeFFVakV4TmhvTENNYi9FQkFDR2dORFFVUTRISER2OWdzPRIGCAAgAigBIgA&hl=en&gl=CA&curr=CAD';
const BUDGETAIR = 'https://www.budgetair.com/en_ca/checkout/upsell?flightType=Return&ch=googleflightsmetaca';

const SCENARIOS = [
  ['booking page only', []],
  ['budgetair checkout first', [BUDGETAIR]],
  ['booking page, budgetair checkout, booking page again', [BOOKING, BUDGETAIR]],
  ['budgetair home first', ['https://www.budgetair.com/en_ca']],
];

async function sellers(ctx) {
  const page = await ctx.newPage();
  try {
    await page.goto(BOOKING, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const until = Date.now() + 45_000;
    let rejected = 0;
    while (Date.now() < until) {
      for (const r of await page.evaluate(() => window.__rpc.splice(0))) {
        if (!r.url.includes('GetBookingResults') || r.text == null) continue;
        const payloads = parseBatchExecute(r.text).filter((p) => p != null);
        if (payloads.length) return payloads.flatMap(parseBooking);
        rejected++;
      }
      await page.waitForTimeout(300);
    }
    const text = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
    const m = text.match(/Booking options.{0,400}/);
    throw new Error(`no GetBookingResults (${rejected} rejected); page: ${m ? m[0] : text.slice(0, 300)}`);
  } finally {
    await page.close();
  }
}

async function run(name, visits) {
  const { browser, ctx } = await openBrowser();
  try {
    for (const url of visits) {
      if (url === BOOKING) { await sellers(ctx).catch(() => {}); console.log('  loaded the booking page'); continue; }
      const page = await ctx.newPage();
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => ({ status: () => e.message.split('\n')[0], url: () => '' }));
      await page.waitForTimeout(8000);
      console.log(`  visited ${url.slice(0, 70)}: ${r?.status?.()} → ${page.url().slice(0, 70)} "${(await page.title().catch(() => '')).slice(0, 50)}"`);
      await page.close();
    }
    const cookies = await ctx.cookies();
    console.log(`  cookies: ${cookies.map((c) => `${c.domain}:${c.name}`).join(' ').slice(0, 600)}`);
    const opts = (await sellers(ctx)).sort((a, b) => a.price - b.price);
    console.log(`## ${name}: cheapest ${opts[0]?.price ?? '—'}`);
    for (const o of opts.slice(0, 8)) console.log(`  ${String(o.price).padStart(6)} ${o.airlineDirect ? 'airline' : 'agency '} ${o.sellerName}`);
  } catch (e) {
    console.log(`## ${name}: ${e.message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log(`booking-page sellers at ${new Date().toISOString()}`);
  for (const [name, visits] of SCENARIOS) await run(name, visits);
})();
