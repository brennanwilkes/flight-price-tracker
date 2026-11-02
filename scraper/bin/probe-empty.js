#!/usr/bin/env node
'use strict';
/* Probe: search pages that inline no results (seen most on routes to and from YYJ). Does another
 * form of the same search inline them?
 *   node scraper/bin/probe-empty.js SIN-YYJ-J-2027-09-20 YYJ-TPE-J-2027-09-10-2027-09-24 ...
 */
const { HEADERS } = require('../src/gflights/page');
const { buildTfs } = require('../src/gflights/tfs');
const { parseOptions } = require('../src/gflights/flights');

async function get(label, url) {
  const t0 = Date.now();
  const res = await fetch(url, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const html = await res.text();
  const opts = res.status === 200 ? parseOptions(html) : null;
  console.log(`  ${label.padEnd(26)} ${res.status} ${Date.now() - t0}ms ${(html.length / 1024).toFixed(0)}KB rows=${opts?.length ?? 'none'}`);
}

async function main() {
  for (const arg of process.argv.slice(2)) {
    const [from, to, cabin, ...d] = arg.split('-');
    const out = d.slice(0, 3).join('-'), ret = d.length > 3 ? d.slice(3, 6).join('-') : null;
    console.log(arg);
    const tfs = (x = {}) => buildTfs({ from, to, out, ret, cabin, ...x });
    const base = 'https://www.google.com/travel/flights';
    await get('base', `${base}?tfs=${tfs()}&hl=en&gl=CA&curr=CAD`);
    await get('base again', `${base}?tfs=${tfs()}&hl=en&gl=CA&curr=CAD`);
    await get('/search', `${base}/search?tfs=${tfs()}&hl=en&gl=CA&curr=CAD`);
    await get('/search + tfu', `${base}/search?tfs=${tfs()}&tfu=EgYIABAAGAA&hl=en&gl=CA&curr=CAD`);
    await get('gl=US', `${base}?tfs=${tfs()}&hl=en&gl=US&curr=CAD`);
    await get('max 1 stop', `${base}?tfs=${tfs({ maxStops: 2 })}&hl=en&gl=CA&curr=CAD`);
    await get('after 6', `${base}?tfs=${tfs({ after: 6 })}&hl=en&gl=CA&curr=CAD`);
    await new Promise((r) => setTimeout(r, 20_000));
    await get('base 20 s later', `${base}?tfs=${tfs()}&hl=en&gl=CA&curr=CAD`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
