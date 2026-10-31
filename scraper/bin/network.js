#!/usr/bin/env node
'use strict';
/* Check hop-network pairs now (src/network): all due pairs, or the given cities' pairs. Sweeps do
 * this a slice at a time; this is for a first full map or a look at a few cities.
 *
 *   node scraper/bin/network.js --data <dataDir> [--cities DAD,HUI,…] [--max 2000]
 */
const path = require('node:path');
const { planNetwork, checkPairs, routesOf } = require('../src/network');
const { openBrowser, shoppingResults } = require('../src/gflights/browser');
const { readJson, writeJson } = require('../src/store/routes');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

async function main() {
  const dataDir = arg('data');
  if (!dataDir) throw new Error('--data <dir> is required');
  const file = path.join(dataDir, 'state', 'network.json');
  const network = readJson(file, { pairs: {} });
  const cities = arg('cities')?.split(',');
  const pairs = cities
    ? cities.flatMap((a) => cities.filter((b) => b !== a).map((b) => [a, b]))
    : planNetwork(network, Date.now(), Number(arg('max', 2000)));
  const t0 = Date.now();
  const { browser, ctx } = await openBrowser();
  try {
    const s = await checkPairs(network, pairs, { browser: (q) => shoppingResults(ctx, q) });
    writeJson(file, network);
    console.log(`network: ${s.checked} pairs checked, ${s.kept} short, ${s.failed} failed; ${routesOf(network).length} routes known; ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
