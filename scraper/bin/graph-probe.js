#!/usr/bin/env node
'use strict';
/* M1 spike: full-window price graph sweep.
 *   node scraper/bin/graph-probe.js YVR-ICN,YVR-TPE [--cabins J,Y] [--lens 14,17,21]
 *     [--start 2027-09-01] [--end 2028-02-29] [--json out.json]
 * Exits 1 if any combination failed.
 */
const fs = require('node:fs');
const { openBrowser, priceGraph } = require('../src/gflights/browser');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

async function main() {
  const routes = process.argv[2].split(',').map((r) => r.split('-'));
  const cabins = arg('cabins', 'J,Y').split(',');
  const lens = arg('lens', '14,17,21').split(',').map(Number);
  const start = arg('start', '2027-09-01');
  const end = arg('end', '2028-02-29');
  const { browser, ctx } = await openBrowser();
  const results = [];
  let failed = 0;
  const t0 = Date.now();
  try {
    for (const [from, to] of routes) {
      for (const cabin of cabins) {
        for (const tripLen of lens) {
          const t = Date.now();
          try {
            const cells = await priceGraph(ctx, { from, to, cabin, tripLen, start, end });
            const priced = cells.filter((c) => c.price != null);
            const min = priced.reduce((m, c) => (c.price < m.price ? c : m), priced[0] ?? {});
            console.log(`${from}-${to} ${cabin} ${tripLen}d: ${cells.length} days, ${priced.length} priced (${cells[0]?.out}…${cells.at(-1)?.out}), min ${min.price ?? '-'} ${min.out ?? ''} [${Date.now() - t}ms]`);
            results.push({ from, to, cabin, tripLen, cells });
          } catch (e) {
            failed++;
            console.log(`${from}-${to} ${cabin} ${tripLen}d: FAILED ${e.message} [${Date.now() - t}ms]`);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  const total = results.length + failed;
  console.log(`ok ${results.length}/${total}, ${results.reduce((n, r) => n + r.cells.length, 0)} cells, ${Math.round((Date.now() - t0) / 1000)}s`);
  const out = arg('json');
  if (out) fs.writeFileSync(out, JSON.stringify(results));
  if (failed) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
