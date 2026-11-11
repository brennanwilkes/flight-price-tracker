#!/usr/bin/env node
'use strict';
/* What makes Google show an agency's lower price? 2026-11-11: YVR⇄HKG J Sep 10-25 showed
 * Trip.com $2,785 in a regular (signed-out) tab, $4,612 incognito, $4,870 to a CI runner.
 * Each scenario: a fresh browser, some pages visited first, then the same search; prints the
 * cheapest rows and the Google cookies the visit left.
 *   node scraper/bin/fare-trigger-probe.js YVR HKG 2027-09-10 2027-09-25 J
 */
const { parseResults } = require('../src/gflights/flights');
const { openBrowser, shoppingResults } = require('../src/gflights/browser');

const [from, to, out, ret, cabin = 'Y'] = process.argv.slice(2);
const query = { from, to, out, ret, cabin };
const tripCls = { Y: 'Y', J: 'C' }[cabin] ?? 'Y';
const tripSearch = `https://ca.trip.com/flights/showfarefirst/?dcity=${from}&acity=${to}&ddate=${out}&rdate=${ret}&flighttype=D&class=${tripCls}&quantity=1&curr=CAD&locale=en-CA`;
const gfHome = 'https://www.google.com/travel/flights?hl=en&gl=CA&curr=CAD';

const SCENARIOS = [
  ['clean', []],
  ['google flights visited first', [gfHome]],
  ['trip.com home first', ['https://ca.trip.com/?locale=en-CA&curr=CAD']],
  ['trip.com same search first', [tripSearch]],
  ['budgetair home first', ['https://www.budgetair.ca/']],
  ['trip.com search, then this search twice', [tripSearch, 'SEARCH']],
];

async function run(name, visits) {
  const { browser, ctx } = await openBrowser();
  try {
    for (const url of visits) {
      if (url === 'SEARCH') { await shoppingResults(ctx, query, { timeout: 60_000 }).catch(() => {}); continue; }
      const page = await ctx.newPage();
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => ({ status: () => e.message.split('\n')[0] }));
      await page.waitForTimeout(6000);
      console.log(`  visited ${url.slice(0, 60)}: ${r?.status?.()} "${(await page.title().catch(() => '')).slice(0, 60)}"`);
      await page.close();
    }
    const cookies = (await ctx.cookies()).map((c) => `${c.domain}:${c.name}`);
    console.log(`  cookies: ${cookies.filter((c) => /google/.test(c)).join(' ') || '—'} | others ${cookies.filter((c) => !/google/.test(c)).length}`);
    const rows = (await shoppingResults(ctx, query, { timeout: 60_000 })).flatMap(parseResults).sort((a, b) => a.price - b.price);
    const seen = new Set();
    const top = rows.filter((o) => { const k = `${o.price} ${o.legs.map((l) => `${l.code}${l.depDate}`)}`; return !seen.has(k) && seen.add(k); }).slice(0, 5);
    console.log(`## ${name}: cheapest ${rows[0]?.price ?? '—'} (${rows.length} rows)`);
    for (const o of top) console.log(`  ${String(o.price).padStart(6)}  ${o.legs.map((l) => `${l.code} ${l.depDate} ${l.dep}`).join(' / ')}`);
  } catch (e) {
    console.log(`## ${name}: ${e.message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log(`${from}⇄${to} ${cabin} ${out}/${ret} at ${new Date().toISOString()}`);
  for (const [name, visits] of SCENARIOS) await run(name, visits);
})();
