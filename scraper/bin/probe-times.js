#!/usr/bin/env node
'use strict';
/* Probe: can a search page take a departure-time window in its `tfs`, so the flights after a
 * connection come back inlined (plain HTTP) instead of needing the browser's full list?
 *   node scraper/bin/probe-times.js YVR ICN 2026-12-01 [--browser]
 * Part 1 adds candidate segment fields to a one-way search and reports the departure hours that
 * come back. Part 2 (--browser) sets the Times filter in a real page and decodes the URL it ends on.
 */
const { HEADERS } = require('../src/gflights/page');
const { parseOptions } = require('../src/gflights/flights');

function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}
const key = (f, w) => varint((f << 3) | w);
const vf = (f, n) => Buffer.concat([key(f, 0), varint(n)]);
const bf = (f, p) => { const b = Buffer.isBuffer(p) ? p : Buffer.from(p); return Buffer.concat([key(f, 2), varint(b.length), b]); };

function tfs(from, to, date, extra = Buffer.alloc(0)) {
  const seg = Buffer.concat([bf(2, date), bf(13, Buffer.concat([vf(1, 1), bf(2, from)])), bf(14, Buffer.concat([vf(1, 1), bf(2, to)])), extra]);
  return Buffer.concat([vf(1, 28), vf(2, 2), bf(3, seg), vf(8, 1), vf(9, 1), vf(14, 1), vf(19, 2)]).toString('base64url');
}

// Generic protobuf dump, for the URL the browser ends on.
function dump(buf, depth = 0) {
  const out = [];
  let i = 0;
  const rd = () => { let n = 0, s = 0, b; do { b = buf[i++]; n += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return n; };
  while (i < buf.length) {
    const t = rd(), f = t >> 3, w = t & 7;
    if (w === 0) out.push(`${'  '.repeat(depth)}${f}: ${rd()}`);
    else if (w === 2) {
      const len = rd(), b = buf.subarray(i, i + len); i += len;
      const s = b.toString('utf8');
      if (/^[\x20-\x7e]+$/.test(s)) out.push(`${'  '.repeat(depth)}${f}: "${s}"`);
      else { out.push(`${'  '.repeat(depth)}${f}: {`); try { out.push(dump(b, depth + 1)); } catch { out.push(`${'  '.repeat(depth + 1)}<${b.toString('hex')}>`); } out.push(`${'  '.repeat(depth)}}`); }
    } else throw new Error(`wire ${w}`);
  }
  return out.join('\n');
}

async function plain(label, t) {
  const url = `https://www.google.com/travel/flights?tfs=${t}&hl=en&gl=CA&curr=CAD`;
  const res = await fetch(url, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const opts = res.status === 200 ? parseOptions(await res.text()) : null;
  const hours = opts ? [...new Set(opts.map((o) => o.legs[0].dep.slice(0, 2)))].sort().join(',') : '-';
  console.log(`${label.padEnd(28)} ${res.status} rows=${opts?.length ?? 'none'} dep hours: ${hours}`);
}

async function browserPart(from, to, date) {
  const { openBrowser } = require('../src/gflights/browser');
  const { browser, ctx } = await openBrowser({ lean: true });
  try {
    const page = await ctx.newPage();
    await page.goto(`https://www.google.com/travel/flights?tfs=${tfs(from, to, date)}&hl=en&gl=CA&curr=CAD`, { waitUntil: 'networkidle' });
    console.log('chips:', (await page.getByRole('button').allInnerTexts()).map((s) => s.trim()).filter(Boolean).slice(0, 40).join(' | '));
    await page.getByRole('button', { name: /^Times/ }).first().click();
    await page.waitForTimeout(1500);
    const sliders = page.getByRole('slider');
    console.log('sliders:', await sliders.count(), (await sliders.evaluateAll((s) => s.map((e) => e.getAttribute('aria-label')))).join(' | '));
    const before = page.url();
    await sliders.first().focus();
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(3000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(3000);
    for (const [label, u] of [['before', before], ['after', page.url()]]) {
      const t = new URL(u).searchParams.get('tfs');
      console.log(`${label}: ${u}`);
      if (t) console.log(dump(Buffer.from(t, 'base64url')));
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const [from, to, date] = process.argv.slice(2);
  await plain('baseline', tfs(from, to, date));
  for (const f of [1, 3, 8, 9, 10, 11, 12, 16, 19, 20]) {
    await plain(`f${f} {1:18,2:23}`, tfs(from, to, date, bf(f, Buffer.concat([vf(1, 18), vf(2, 23)]))));
    await plain(`f${f} packed [18,23]`, tfs(from, to, date, bf(f, Buffer.from([18, 23]))));
    await plain(`f${f} varint 18`, tfs(from, to, date, vf(f, 18)));
  }
  if (process.argv.includes('--browser')) await browserPart(from, to, date);
}
main().catch((e) => { console.error(e); process.exit(1); });
