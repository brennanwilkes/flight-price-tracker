#!/usr/bin/env node
'use strict';
/* Long-leg price-graph sweep: every origin × destination × cabin × trip length across the window.
 *   node scraper/bin/sweep.js --data <dataDir> [--egress vpn|direct] [--routes YVR-ICN,YYJ-TYO]
 *
 * Control route first: if it returns no prices, Google (or our scraper) is broken, not the market,
 * so the run aborts as failed. Writes route files (src/store/routes.js), state/health.json, and a
 * one-line summary to <dataDir>/.sweep-summary for the commit message. Exits 1 on a failed run.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config/long-leg.json');
const { openBrowser, priceGraph, addDays } = require('../src/gflights/browser');
const { recordCells, readJson, writeJson } = require('../src/store/routes');

const MAX_FAILED_SHARE = 0.25; // more failed combos than this = failed run
const HEALTH_RUNS_KEPT = 200;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

function plan(only) {
  const combos = [];
  for (const from of config.origins) {
    for (const [dest, airports] of Object.entries(config.destinations)) {
      if (only && !only.includes(`${from}-${dest}`)) continue;
      for (const cabin of config.cabins) {
        for (const tripLen of config.tripLengths) {
          combos.push({ routeId: `${from}-${dest}-${cabin}`, from, to: airports.length === 1 ? airports[0] : airports, cabin, tripLen });
        }
      }
    }
  }
  return combos;
}

async function withRetry(fn, label) {
  try {
    return await fn();
  } catch (e) {
    console.log(`  ${label}: retrying after ${e.message}`);
    return fn();
  }
}

async function main() {
  const dataDir = arg('data');
  if (!dataDir) throw new Error('--data <dir> is required');
  const egress = arg('egress', 'direct');
  const only = arg('routes')?.split(',');
  const observedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const t0 = Date.now();
  const run = { at: observedAt, egress, control: null, ok: 0, failed: 0, cells: 0, priced: 0, changes: 0, errors: [] };

  const { browser, ctx } = await openBrowser();
  try {
    const c = config.control;
    const start = addDays(observedAt.slice(0, 10), c.daysOut);
    try {
      const cells = await withRetry(() => priceGraph(ctx, { ...c, start, end: addDays(start, c.days - 1) }), 'control');
      run.control = cells.filter((x) => x.price != null).length;
    } catch (e) {
      run.control = 0;
      run.errors.push(`control: ${e.message}`);
    }
    console.log(`control ${c.from}-${c.to} ${c.cabin}: ${run.control} priced days`);

    if (run.control > 0) {
      const { start: wStart, end: wEnd } = config.window;
      for (const q of plan(only)) {
        const label = `${q.routeId} ${q.tripLen}d`;
        try {
          const cells = await withRetry(() => priceGraph(ctx, { ...q, start: wStart, end: wEnd }), label);
          const changes = recordCells(dataDir, q.routeId, q.tripLen, cells, { observedAt, egress });
          const priced = cells.filter((x) => x.price != null);
          run.ok++;
          run.cells += cells.length;
          run.priced += priced.length;
          run.changes += changes;
          const min = priced.length ? Math.min(...priced.map((x) => x.price)) : '-';
          console.log(`${label}: ${priced.length}/${cells.length} priced, min ${min}, ${changes} changed`);
        } catch (e) {
          run.failed++;
          run.errors.push(`${label}: ${e.message}`);
          console.log(`${label}: FAILED ${e.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  run.seconds = Math.round((Date.now() - t0) / 1000);
  const total = run.ok + run.failed;
  const success = run.control > 0 && total > 0 && run.failed / total <= MAX_FAILED_SHARE;
  const healthFile = path.join(dataDir, 'state', 'health.json');
  const health = readJson(healthFile, { consecutiveFailures: 0, lastSuccess: null, runs: [] });
  health.consecutiveFailures = success ? 0 : health.consecutiveFailures + 1;
  if (success) health.lastSuccess = observedAt;
  health.runs = [{ ...run, success }, ...health.runs].slice(0, HEALTH_RUNS_KEPT);
  writeJson(healthFile, health);

  const summary = `sweep ${observedAt} | ${success ? 'OK' : 'FAILED'} | ${run.ok}/${total} combos | ${run.priced} priced, ${run.changes} changed | control ${run.control} | ${egress} | ${run.seconds}s`;
  fs.writeFileSync(path.join(dataDir, '.sweep-summary'), `${summary}\n${run.errors.map((e) => `- ${e}`).join('\n')}\n`);
  console.log(summary);
  if (!success) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
