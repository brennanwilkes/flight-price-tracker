#!/usr/bin/env node
'use strict';
/* Probe: can one loaded results page answer several searches, without a full page load each?
 *   node scraper/bin/probe-spa.js SIN YYJ 2027-09-10 5
 * Loads the first date, then moves to the next days by (a) history.pushState + popstate and
 * (b) the date field's next-day button, timing each GetShoppingResults and checking its date.
 */
const { openBrowser, addDays } = require('../src/gflights/browser');
const { pageUrl } = require('../src/gflights/page');
const { parseBatchExecute } = require('../src/gflights/batchexecute');
const { parseResults } = require('../src/gflights/flights');

async function waitRpc(page, seen, ms = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const fresh = await page.evaluate((i) => window.__rpc.slice(i), seen);
    for (const r of fresh) {
      if (!r.url.includes('GetShoppingResults') || !r.text) continue;
      const opts = parseBatchExecute(r.text).filter(Boolean).flatMap(parseResults);
      if (opts.length) return { ms: Date.now() - t0, n: opts.length, dates: [...new Set(opts.map((o) => o.legs[0].depDate))].join(',') };
    }
    await page.waitForTimeout(200);
  }
  return { ms: Date.now() - t0, n: 0, dates: 'timeout' };
}

async function main() {
  const [from, to, date, n = '4'] = process.argv.slice(2);
  const { browser, ctx } = await openBrowser({ lean: true });
  try {
    const page = await ctx.newPage();
    let t0 = Date.now();
    await page.goto(pageUrl({ from, to, out: date, cabin: 'Y' }), { waitUntil: 'domcontentloaded' });
    console.log('full load', date, JSON.stringify(await waitRpc(page, 0)), 'total', Date.now() - t0);
    const btns = (await page.getByRole('button').evaluateAll((b) => b.map((e) => e.getAttribute('aria-label')).filter(Boolean))).filter((l) => /day|date/i.test(l));
    console.log('date buttons:', btns.join(' | '));
    let d = date;
    for (let i = 0; i < Number(n); i++) {
      d = addDays(d, 1);
      const seen = await page.evaluate(() => window.__rpc.length);
      const url = pageUrl({ from, to, out: d, cabin: 'Y' });
      t0 = Date.now();
      await page.evaluate((u) => { history.pushState({}, '', u); window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); }, url);
      console.log('popstate', d, JSON.stringify(await waitRpc(page, seen, 15_000)));
    }
    for (let i = 0; i < Number(n); i++) {
      const seen = await page.evaluate(() => window.__rpc.length);
      const next = page.getByRole('button', { name: /next|later|forward/i }).first();
      t0 = Date.now();
      await next.click({ timeout: 5000 }).catch((e) => console.log('click failed', e.message.split('\n')[0]));
      console.log('next-day button', JSON.stringify(await waitRpc(page, seen, 15_000)), page.url().slice(0, 120));
    }
    // Plain full loads for comparison, same page.
    for (let i = 0; i < 2; i++) {
      d = addDays(d, 1);
      const seen = await page.evaluate(() => window.__rpc.length);
      t0 = Date.now();
      await page.goto(pageUrl({ from, to, out: d, cabin: 'Y' }), { waitUntil: 'domcontentloaded' });
      console.log('goto', d, JSON.stringify(await waitRpc(page, 0)), 'total', Date.now() - t0, seen);
    }
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
