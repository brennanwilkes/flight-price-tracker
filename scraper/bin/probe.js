#!/usr/bin/env node
'use strict';
/* M1 probe: fetch one search page and report what it carries.
 *   node scraper/bin/probe.js YVR ICN 2027-09-15 2027-09-29 J [--save out.html]
 */
const fs = require('node:fs');
const { fetchPage, extractBlobs } = require('../src/gflights/page');

async function main() {
  const [from, to, out, ret, cabin = 'Y'] = process.argv.slice(2);
  const saveIdx = process.argv.indexOf('--save');
  const r = await fetchPage({ from, to, out, ret: ret === '-' ? null : ret, cabin });
  console.log(`${r.status} ${r.ms}ms ${(r.bytes / 1024).toFixed(0)}KB ${r.location ? `→ ${r.location}` : ''}`);
  console.log(r.url);
  if (saveIdx > 0) fs.writeFileSync(process.argv[saveIdx + 1], r.html);
  const blobs = extractBlobs(r.html);
  console.log('blobs:', Object.keys(blobs).join(' '));
  const ds1 = blobs['ds:1'];
  if (!ds1) { console.log('NO ds:1'); process.exitCode = 1; return; }
  const rows = [...(ds1[2]?.[0] ?? []), ...(ds1[3]?.[0] ?? [])];
  console.log(`rows: best=${ds1[2]?.[0]?.length ?? 0} other=${ds1[3]?.[0]?.length ?? 0}`);
  for (const row of rows.slice(0, 50)) {
    const d = row[0];
    const price = row[1]?.[0]?.at(-1);
    const legs = (d[2] ?? []).map((l) => `${l[22]?.[0]}${l[22]?.[1]} ${l[3]}-${l[6]} ${Math.round(l[11] / 6) / 10}h`);
    console.log(`  ${String(price).padStart(6)}  ${d[1]?.[0] ?? ''} | ${legs.join(' / ')}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
