#!/usr/bin/env node
'use strict';
/* Probe: how does a round trip's search link carry the chosen outbound, so the return list is
 * that ticket's returns (not the cheapest one-way home)?
 *   node scraper/bin/probe-return.js YVR ICN 2027-09-01 2027-09-22 J PR117,PR400
 * 1) loads the round trip and lists its outbound rows; 2) clicks the row flying the given flights
 * and decodes the tfs Google puts in the address bar, listing the returns it shows; 3) loads our
 * own tfs with those flights selected (tfs.js `selected`) and lists what it shows.
 */
const { openBrowser } = require('../src/gflights/browser');
const { pageUrl } = require('../src/gflights/page');
const { parseBatchExecute } = require('../src/gflights/batchexecute');
const { parseResults } = require('../src/gflights/flights');

const show = (o) => `${o.price} ${o.legs.map((l) => `${l.code} ${l.from}${l.depDate.slice(5)} ${l.dep}>${l.to}`).join(' + ')}`;

// Protobuf dump: field -> value, nested where the bytes parse as a message.
function decode(buf, depth = 0) {
  const out = [];
  let i = 0;
  const varint = () => { let n = 0, s = 0, b; do { b = buf[i++]; n += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return n; };
  while (i < buf.length) {
    const k = varint(); const f = Math.floor(k / 8); const w = k & 7;
    if (w === 0) out.push(`${f}=${varint()}`);
    else if (w === 2) {
      const len = varint(); const b = buf.subarray(i, i + len); i += len;
      let inner = null;
      if (depth < 4 && len) { try { inner = decode(b, depth + 1); } catch {} }
      const txt = b.toString('utf8');
      out.push(inner && !/^[\x20-\x7e]+$/.test(txt) ? `${f}{${inner}}` : `${f}="${txt}"`);
    } else if (w === 5) { out.push(`${f}=f32:${buf.readUInt32LE(i)}`); i += 4; }
    else if (w === 1) { out.push(`${f}=f64:${buf.subarray(i, i + 8).toString('hex')}`); i += 8; }
    else throw new Error(`wire ${w}`);
    if (i > buf.length) throw new Error('overrun');
  }
  return out.join(' ');
}
const tfsOf = (url) => {
  const t = new URL(url).searchParams.get('tfs');
  if (!t) return `(no tfs: ${url.slice(0, 200)})`;
  try { return `${decode(Buffer.from(t, 'base64url'))}  [${t}]`; } catch (e) { return `(undecodable ${e.message}: ${t})`; }
};

async function rows(page, seen, ms = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const fresh = await page.evaluate((i) => window.__rpc.slice(i), seen);
    for (const r of fresh) {
      if (!r.url.includes('GetShoppingResults') || !r.text) continue;
      const opts = parseBatchExecute(r.text).filter(Boolean).flatMap(parseResults);
      if (opts.length) return opts;
    }
    await page.waitForTimeout(300);
  }
  return [];
}

async function main() {
  const [from, to, out, ret, cabin, codes] = process.argv.slice(2);
  const want = codes.split(',');
  const q = { from, to, out, ret, cabin };
  const { browser, ctx } = await openBrowser({ lean: true });
  try {
    const page = await ctx.newPage();
    await page.goto(pageUrl(q), { waitUntil: 'domcontentloaded' });
    const outs = await rows(page, 0);
    console.log(`1) outbound rows: ${outs.length}`);
    for (const o of outs.slice(0, 12)) console.log('   ', show(o));
    const pick = outs.find((o) => o.legs.map((l) => l.code).join(',') === want.join(','));
    if (!pick) console.log('   no row flies', codes);
    console.log('   our tfs:', tfsOf(page.url()));

    // 2) Click it in the page.
    if (pick) {
      const idx = outs.indexOf(pick);
      const items = page.locator('li:has([aria-label*="Select flight"]), ul[role="list"] > li').filter({ hasText: /CA\$|\$/ });
      console.log(`2) list items: ${await items.count()}, clicking row ${idx} (${show(pick)})`);
      const more = page.getByRole('button', { name: /more flights/i }).first();
      if (idx > 3 && await more.isVisible({ timeout: 3000 }).catch(() => false)) await more.click();
      const label = pick.airlines[0] ?? '';
      const target = items.filter({ hasText: label }).filter({ hasText: String(pick.price).replace(/\B(?=(\d{3})+$)/g, ',') }).first();
      const seen = await page.evaluate(() => window.__rpc.length);
      try {
        await target.click({ timeout: 15_000 });
        await page.waitForURL((u) => u.toString() !== page.url(), { timeout: 15_000 }).catch(() => {});
        const backs = await rows(page, seen);
        await page.waitForTimeout(1500);
        console.log('   address bar tfs:', tfsOf(page.url()));
        console.log(`   return rows: ${backs.length}`);
        for (const o of backs.slice(0, 12)) console.log('   ', show(o));
      } catch (e) { console.log('   click failed:', e.message.split('\n')[0]); }
    }

    // 3) Our own tfs with the flights selected.
    if (pick) {
      const selected = pick.legs.map((l) => ({ from: l.from, to: l.to, date: l.depDate, airline: l.code.slice(0, 2), number: l.code.slice(2) }));
      const p3 = await ctx.newPage();
      const url = pageUrl({ ...q, selected });
      console.log('3) ours:', tfsOf(url));
      await p3.goto(url, { waitUntil: 'domcontentloaded' });
      const backs = await rows(p3, 0);
      console.log(`   rows: ${backs.length}`);
      for (const o of backs.slice(0, 12)) console.log('   ', show(o));
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
