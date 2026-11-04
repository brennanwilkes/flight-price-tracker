#!/usr/bin/env node
'use strict';
/* Price-graph sweep across the travel window (config/sweep.json, src/sweep/plan.js): long legs,
 * hops and Asia round trips, each graph refreshed by its tier's max age, the most overdue first,
 * until the time budget runs out (the rest waits for the next sweep). Before that, a slice of the
 * hop network is re-checked (src/network). State: state/graphs.json, state/graph-fails.json,
 * state/network.json.
 *
 *   node scraper/bin/sweep.js --data <dataDir> [--egress vpn|direct] [--routes YVR-ICN,ICN-DAD]
 *
 * --routes: only graphs of those city pairs, whatever their age (no network check).
 *
 * Control route first: if it returns no prices, Google (or our scraper) is broken, not the market,
 * so the run aborts as failed. Writes route files (src/store/routes.js), state/health.json, and a
 * one-line summary to <dataDir>/.sweep-summary for the commit message. Exits 1 on a failed run.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config/sweep.json');
const { bgrTally, openBrowser, priceGraph, shoppingResults, addDays } = require('../src/gflights/browser');
const { recordCells, readJson, writeJson } = require('../src/store/routes');
const { planSweep, graphKey } = require('../src/sweep/plan');
const { planNetwork, checkPairs, routesOf } = require('../src/network');
const { airportsOf } = require('../../frontend/app/cities.js');

const MAX_FAILED_SHARE = 0.25; // more failed combos than this = failed run
const HEALTH_RUNS_KEPT = 200;
const CONCURRENCY = Number(process.env.SWEEP_CONCURRENCY || 3); // pages open at once
// While a big backlog builds up (new graphs' first scrapes), more pages at once and a bigger hop
// network slice until every pair has been checked once; both back to normal by themselves.
const BACKLOG = 400;
const CONCURRENCY_BACKLOG = 6;

/** Run `fn` over `items` with at most `n` in flight. */
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

// Scraping stops starting combos after this, leaving the trip build and push inside the job limit.
const BUDGET_MS = config.budgetMinutes * 60_000;

async function withRetry(fn, label) {
  try {
    return await fn();
  } catch (e) {
    console.log(`  ${label}: retrying after ${e.message}`);
    return fn();
  }
}

/** state/graphs.json from the old state/hops.json ('A-B' → last scrape), once. */
function migrateHops(dataDir) {
  const hops = readJson(path.join(dataDir, 'state', 'hops.json'), {});
  fs.rmSync(path.join(dataDir, 'state', 'hops.json'), { force: true });
  return Object.fromEntries(Object.entries(hops).map(([k, at]) => [`${k}-Y-OW|0`, at]));
}

async function main() {
  const dataDir = arg('data');
  if (!dataDir) throw new Error('--data <dir> is required');
  const egress = arg('egress', 'direct');
  const only = arg('routes')?.split(',');
  const stateFile = path.join(dataDir, 'state', 'graphs.json');
  const failsFile = path.join(dataDir, 'state', 'graph-fails.json');
  const networkFile = path.join(dataDir, 'state', 'network.json');
  const state = readJson(stateFile, null) ?? migrateHops(dataDir);
  const network = readJson(networkFile, { pairs: {} });
  const fails = readJson(failsFile, {});
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
      // A slice of the hop network first (plain requests, ~2 min): the plan below uses it.
      if (!only) {
        const unchecked = Object.keys(network.pairs ?? {}).length < planNetwork({ pairs: {} }, Date.now(), Infinity).length;
        const s = await checkPairs(network, planNetwork(network, Date.now(), config.networkPerSweep * (unchecked ? 2 : 1)),
          { browser: (q) => shoppingResults(ctx, q), at: observedAt });
        run.network = { ...s, routes: routesOf(network).length };
        writeJson(networkFile, network);
        console.log(`network: ${s.checked} pairs checked, ${s.kept} short, ${s.failed} failed; ${run.network.routes} routes known`);
      }
      const { start: wStart, end: wEnd } = config.window;
      const work = planSweep(config, state, network, Date.now(), only, fails);
      run.due = work.length;
      run.pages = work.length > BACKLOG ? Math.max(CONCURRENCY, CONCURRENCY_BACKLOG) : CONCURRENCY;
      await pool(work, run.pages, async (q) => {
        const label = q.tripLen == null ? q.routeId : `${q.routeId} ${q.tripLen}d`;
        if (Date.now() - t0 > BUDGET_MS) { run.skipped = (run.skipped ?? 0) + 1; return; } // next sweep
        try {
          const cells = await withRetry(() => priceGraph(ctx, { ...q, from: airportsOf(q.from), to: airportsOf(q.to), start: wStart, end: wEnd }), label);
          const changes = recordCells(dataDir, q.routeId, q.tripLen ?? 0, cells, { observedAt, egress });
          state[graphKey(q)] = observedAt;
          delete fails[graphKey(q)];
          const priced = cells.filter((x) => x.price != null);
          run.ok++;
          run.cells += cells.length;
          run.priced += priced.length;
          run.changes += changes;
          const min = priced.length ? Math.min(...priced.map((x) => x.price)) : '-';
          console.log(`${label}: ${priced.length}/${cells.length} priced, min ${min}, ${changes} changed`);
        } catch (e) {
          run.failed++;
          fails[graphKey(q)] = { n: (fails[graphKey(q)]?.n ?? 0) + 1, at: observedAt };
          run.errors.push(`${label}: ${e.message}`);
          console.log(`${label}: FAILED ${e.message}`);
        }
      });
    }
  } finally {
    await browser.close();
  }

  writeJson(stateFile, Object.fromEntries(Object.entries(state).sort()));
  writeJson(failsFile, Object.fromEntries(Object.entries(fails).sort()));
  run.seconds = Math.round((Date.now() - t0) / 1000);
  const total = run.ok + run.failed;
  // Nothing due (every graph fresh) is a healthy sweep, not a failed one.
  const success = run.control > 0 && (total > 0 ? run.failed / total <= MAX_FAILED_SHARE : run.due === 0);
  const healthFile = path.join(dataDir, 'state', 'health.json');
  const health = readJson(healthFile, { consecutiveFailures: 0, lastSuccess: null, runs: [] });
  health.consecutiveFailures = success ? 0 : health.consecutiveFailures + 1;
  if (success) health.lastSuccess = observedAt;
  health.runs = [{ ...run, success }, ...health.runs].slice(0, HEALTH_RUNS_KEPT);
  writeJson(healthFile, health);

  const summary = `sweep ${observedAt} | ${success ? 'OK' : 'FAILED'} | ${run.ok}/${total} combos${run.skipped ? ` (${run.skipped} left for next sweep)` : ''} | ${run.priced} priced, ${run.changes} changed | control ${run.control} | ${egress} | ${run.seconds}s`;
  fs.writeFileSync(path.join(dataDir, '.sweep-summary'), `${summary}\n${run.errors.map((e) => `- ${e}`).join('\n')}\n`);
  console.log(`rpc replies: ok ${bgrTally.ok.bgr} with bgr header / ${bgrTally.ok.none} without; rejected ${bgrTally.rejected.bgr} with / ${bgrTally.rejected.none} without`);
  console.log(summary);
  if (!success) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
