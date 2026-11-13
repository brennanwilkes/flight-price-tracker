#!/usr/bin/env node
'use strict';
/* Push this run's deals (src/alerts/rules.js) and the scraper-failure alert, after the data push:
 * each push links to the dashboard pinned at that data commit, so it opens on the prices it names.
 *
 *   node scraper/bin/alerts.js --data <dataDir> --sha <data commit>
 *
 * Ledger: state/alerts.json { deals: { key: { total, tier, at } } }. Written only for pushes the
 * Worker accepted. With no ledger yet, it's seeded with the current deals and nothing is sent (no
 * flood on the first run). Without NOTIFY_SECRET it prints what it would send.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config/alerts.json');
const sweepConfig = require('../config/sweep.json');
const { rowName } = require('../../frontend/app/cities.js');
const { rowId } = require('../../frontend/app/build.js');
const { unpack } = require('../../frontend/app/pack.js');
const { lows, findDeals, isNews, pairOf } = require('../src/alerts/rules');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const readJson = (f, def) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : def);
const money = (n) => `$${n.toLocaleString('en-CA')}`;

function dealUrl(d, sha) {
  return `${config.dashboard}?home=${d.home}&sweep=1&v=${sha}#trip=${rowId(d)}~${d.cls}`;
}

// Two lines, as the board's title line has it: the route, then class and price.
function message(d, sha) {
  return {
    title: rowName(d),
    body: `${d.cls === 'hybrid' ? 'Business' : 'Economy'} ${money(d.trip.total)}`,
    url: dealUrl(d, sha),
    tag: d.key,
  };
}
async function send(msg) {
  if (!process.env.NOTIFY_SECRET) { console.log(`(no NOTIFY_SECRET) would push: ${msg.title} | ${msg.body} | ${msg.url}`); return false; }
  const res = await fetch(`${config.worker}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.NOTIFY_SECRET}` },
    body: JSON.stringify(msg),
  });
  const out = await res.text();
  console.log(`push ${res.status}: ${msg.title}${res.ok ? '' : ` → ${out.slice(0, 200)}`}`);
  return res.ok;
}

async function main() {
  const dataDir = arg('data'), sha = arg('sha');
  if (!dataDir || !sha) throw new Error('--data <dir> --sha <commit> are required');
  const ledgerFile = path.join(dataDir, 'state', 'alerts.json');
  const seeding = !fs.existsSync(ledgerFile);
  const ledger = readJson(ledgerFile, { deals: {} });
  // Entries from when a deal was a row ("…,SIN+KUL"): folded into their pair's, the lowest kept, so
  // a pair already pushed isn't pushed again for the change of key.
  for (const [k, v] of Object.entries(ledger.deals)) {
    const p = pairOf(k);
    if (p === k) continue;
    delete ledger.deals[k];
    const cur = ledger.deals[p];
    if (!cur || v.total < cur.total) ledger.deals[p] = v;
  }

  const rows = {};
  let generatedAt = null;
  for (const home of sweepConfig.origins) {
    const f = path.join(dataDir, 'derived', `trips-${home}.json`);
    if (!fs.existsSync(f)) continue;
    const d = unpack(readJson(f));
    rows[home] = d.rows;
    generatedAt = d.generatedAt;
  }
  if (!generatedAt) { console.log('alerts: no trips'); return; }

  // Scraper failing: once, on the second failed run in a row.
  const health = readJson(path.join(dataDir, 'state', 'health.json'), null);
  if (health?.consecutiveFailures === 2) {
    const err = health.runs?.[0]?.errors?.[0] ?? 'no error recorded';
    await send({ title: 'Scraper failed 2 runs in a row', body: String(err).slice(0, 180), url: `${config.dashboard}?v=${sha}`, tag: 'scraper' });
  }

  const deals = findDeals(config, rows, lows(dataDir, config.lowsSince, generatedAt), generatedAt);
  const news = deals.filter((d) => isNews(config, d, ledger.deals[d.key]));
  const record = (d) => { ledger.deals[d.key] = { total: d.trip.total, tier: d.tier, at: generatedAt }; };
  if (seeding) {
    news.forEach(record);
    console.log(`alerts: ledger seeded with ${news.length} deals, nothing sent`);
  } else {
    // At most maxPushesPerRun: the best deals each get one, the rest share the last.
    const cap = config.maxPushesPerRun;
    const solo = news.length > cap ? news.slice(0, cap - 1) : news;
    for (const d of solo) if (await send(message(d, sha))) record(d);
    const rest = news.slice(solo.length);
    if (rest.length) {
      const names = rest.map((d) => `${rowName(d)} ${money(d.trip.total)}`);
      if (await send({ title: `${rest.length} more deals`, body: names.join(' · ').slice(0, 180), url: `${config.dashboard}?sweep=1&v=${sha}`, tag: 'more' })) rest.forEach(record);
    }
    console.log(`alerts: ${deals.length} deals, ${news.length} new`);
  }
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 1)}\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
