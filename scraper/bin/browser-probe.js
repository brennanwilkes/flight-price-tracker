#!/usr/bin/env node
'use strict';
/* M1 spike: does a real browser session get the gated RPCs (calendar, booking) back?
 * Loads a search page, pokes the date UI, and logs every FlightsFrontendService call.
 *   node scraper/bin/browser-probe.js YVR ICN 2026-12-01 2026-12-15 J [outDir]
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { pageUrl } = require('../src/gflights/page');

async function main() {
  const [from, to, out, ret, cabin = 'Y', outDir = '.'] = process.argv.slice(2);
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, headless: true });
  const ctx = await browser.newContext({ locale: 'en-CA', timezoneId: 'America/Vancouver' });
  await ctx.addCookies([{ name: 'SOCS', value: 'CAISNQgQEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwMzE3LjA5X3AwGgJlbiADGgYIgLC_rwY', domain: '.google.com', path: '/' }]);
  const page = await ctx.newPage();
  let n = 0;
  page.on('response', async (res) => {
    const m = /FlightsFrontendService\/(\w+)/.exec(res.url());
    if (!m) return;
    const body = await res.text().catch(() => '');
    const file = path.join(outDir, `${String(++n).padStart(2, '0')}-${m[1]}.txt`);
    fs.writeFileSync(file, body);
    console.log(`  rpc ${m[1]} ${res.status()} ${(body.length / 1024).toFixed(1)}KB → ${path.basename(file)}`);
  });

  const t0 = Date.now();
  await page.goto(pageUrl({ from, to, out, ret: ret === '-' ? null : ret, cabin }), { waitUntil: 'networkidle' });
  console.log(`loaded in ${Date.now() - t0}ms: ${await page.title()}`);
  await page.screenshot({ path: path.join(outDir, 'loaded.png') });

  for (const label of ['Date grid', 'Price graph']) {
    const btn = page.getByRole('button', { name: label }).first();
    if (await btn.count()) {
      console.log(`click "${label}"`);
      await btn.click().catch((e) => console.log('  click failed', e.message.split('\n')[0]));
      await page.waitForTimeout(4000);
      await page.screenshot({ path: path.join(outDir, `${label.replace(' ', '-')}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
    } else console.log(`no "${label}" button`);
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
