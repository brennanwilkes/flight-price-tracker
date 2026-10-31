#!/usr/bin/env node
'use strict';
/* Price-graph sweep across the travel window (config/sweep.json):
 *   - long legs every run: round trips (origin × destination × cabin × trip length) and one-ways
 *     in both directions (YVR-ICN-J-OW, ICN-YVR-J-OW)
 *   - economy hops between the Asia cities, the stalest first, until each is < maxAgeHours old
 *     (state/hops.json). Works with any run schedule.
 *
 *   node scraper/bin/sweep.js --data <dataDir> [--egress vpn|direct] [--homes YVR,YYJ] [--routes YVR-ICN,ICN-DAD] [--no-hops]
 *
 * --homes limits the long legs to those home airports (the Worker sweeps YYJ every 3rd hour).
 *
 * Control route first: if it returns no prices, Google (or our scraper) is broken, not the market,
 * so the run aborts as failed. Writes route files (src/store/routes.js), state/health.json, and a
 * one-line summary to <dataDir>/.sweep-summary for the commit message. Exits 1 on a failed run.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config/sweep.json');
const { openBrowser, priceGraph, addDays } = require('../src/gflights/browser');
const { recordCells, readJson, writeJson } = require('../src/store/routes');

const MAX_FAILED_SHARE = 0.25; // more failed combos than this = failed run
const HEALTH_RUNS_KEPT = 200;
const CONCURRENCY = Number(process.env.SWEEP_CONCURRENCY || 3); // pages open at once

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

const airportsOf = (city) => {
  const a = config.destinations[city] ?? [city];
  return a.length === 1 ? a[0] : a;
};

/** Long legs: every round trip and one-way between home and each Asia city. */
function planLongLegs(only, homes) {
  const { cabins, tripLengths, oneWay } = config.longLeg;
  const combos = [];
  for (const home of homes) {
    for (const city of Object.keys(config.destinations)) {
      for (const cabin of cabins) {
        if (!only || only.includes(`${home}-${city}`)) {
          for (const tripLen of tripLengths) {
            combos.push({ routeId: `${home}-${city}-${cabin}`, from: home, to: airportsOf(city), cabin, tripLen });
          }
          if (oneWay) combos.push({ routeId: `${home}-${city}-${cabin}-OW`, from: home, to: airportsOf(city), cabin, tripLen: null });
        }
        if (oneWay && (!only || only.includes(`${city}-${home}`))) {
          combos.push({ routeId: `${city}-${home}-${cabin}-OW`, from: airportsOf(city), to: home, cabin, tripLen: null });
        }
      }
    }
  }
  return combos;
}

/** Hops due this run: never-swept first, then oldest, skipping any fresher than maxAgeHours. */
function planHops(only, hopState, now) {
  const { cabin, maxAgeHours, maxPerRun } = config.hops;
  const cities = Object.keys(config.destinations);
  const due = [];
  for (const a of cities) {
    for (const b of cities) {
      if (a === b || (only && !only.includes(`${a}-${b}`))) continue;
      const key = `${a}-${b}`;
      const last = hopState[key] ? Date.parse(hopState[key]) : 0;
      if (now - last < maxAgeHours * 3600e3) continue;
      due.push({ last, q: { routeId: `${key}-${cabin}-OW`, hopKey: key, from: airportsOf(a), to: airportsOf(b), cabin, tripLen: null } });
    }
  }
  return due.sort((x, y) => x.last - y.last).slice(0, maxPerRun).map((d) => d.q);
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
  const homes = arg('homes')?.split(',') ?? config.origins;
  const hops = !process.argv.includes('--no-hops');
  const hopsFile = path.join(dataDir, 'state', 'hops.json');
  const hopState = readJson(hopsFile, {});
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
      const work = [...planLongLegs(only, homes), ...(hops ? planHops(only, hopState, Date.now()) : [])];
      await pool(work, CONCURRENCY, async (q) => {
        const label = q.tripLen == null ? q.routeId : `${q.routeId} ${q.tripLen}d`;
        try {
          const cells = await withRetry(() => priceGraph(ctx, { ...q, start: wStart, end: wEnd }), label);
          const changes = recordCells(dataDir, q.routeId, q.tripLen ?? 0, cells, { observedAt, egress });
          if (q.hopKey) hopState[q.hopKey] = observedAt;
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
      });
    }
  } finally {
    await browser.close();
  }

  writeJson(hopsFile, Object.fromEntries(Object.entries(hopState).sort()));
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
