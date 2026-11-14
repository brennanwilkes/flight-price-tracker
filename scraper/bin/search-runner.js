#!/usr/bin/env node
'use strict';
/* Browser searches on the booking job's runner (sweep.yml job `booking`), beside its booking pages.
 * Past 300 days out a search page inlines no results (details.js INLINE_DAYS), and some routes never
 * inline any: each such search is a browser page, 20-25 s on the sweep's runner (CPU-bound beside
 * the scrape and the build), which made ~100-180 of ~10,700 wanted a build (2:05 pm Vancouver,
 * 2026-11-13). This runner's CPU is mostly idle: a booking page every 2.5 s.
 *
 *   node scraper/bin/search-runner.js --queue .search-queue.json --out .search-extra.json.gz
 *     --until <epoch s> [--pages 3] [--gap 1500] [--session-pages 300]
 *
 * --queue: the last build's browser searches left out of time, most wanted first (build-trips.js
 * --search-queue). --out: each result as search-cache rows under the build's keys; the next build
 * merges them (build-trips.js --search-extra), so a search made here is used ~1 h after.
 * A page every --gap ms at most, --pages at once, a new browser session every --session-pages.
 */
const fs = require('node:fs');
const zlib = require('node:zlib');
const { parseResults, dedupe } = require('../src/gflights/flights');
const { openBrowserThread } = require('../src/gflights/browser-thread');

const PAGE_MS = 60_000; // as details.js SLOW_PAGE_MS: some searches (YYJ business returns) take Google > 30 s

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const pct = (a, q) => (a.length ? `${(a.toSorted((x, y) => x - y)[Math.floor(q * (a.length - 1))] / 1000).toFixed(1)} s` : '-');

(async () => {
  const until = Number(arg('until')) * 1000;
  const slots = Number(arg('pages', 3));
  const gap = Number(arg('gap', 1500));
  const sessionMax = Number(arg('session-pages', 300));
  const out = arg('out');
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync(arg('queue'), 'utf8')).searches ?? []; } catch (e) { console.log(`search runner: no queue (${e.message})`); }
  console.log(`search runner: ${queue.length} browser searches queued (${queue.filter((s) => s.had).length} served stale meanwhile)`);
  if (!queue.length) return;

  const rows = [];
  const save = () => {
    fs.writeFileSync(`${out}.tmp`, zlib.gzipSync(rows.map((r) => JSON.stringify(r)).join('\n')));
    fs.renameSync(`${out}.tmp`, out);
  };
  const b = await openBrowserThread({ lean: true });
  // Per 5-minute window and in all: is a session or the IP cut off (pages that list nothing where
  // flights were listed before)?
  const all = { pages: 0, rows: 0, empty: 0, emptyHad: 0, errors: 0, ms: [], why: {} };
  let win = { pages: 0, empty: 0, emptyHad: 0, errors: 0, ms: [] };
  let sessionPages = 0, sessions = 0, renewing = null, next = 0, started = Date.now();
  const t0 = Date.now();
  const tick = setInterval(() => {
    console.log(`  ${Math.round((Date.now() - t0) / 60e3)} min: ${all.pages} searches (${all.errors} errors); this window: ${win.pages} pages, ${win.empty} listing nothing (${win.emptyHad} of them listed flights before), ${win.errors} errors, page ${pct(win.ms, 0.5)} median, ${pct(win.ms, 0.9)} p90; ${sessions} new sessions`);
    win = { pages: 0, empty: 0, emptyHad: 0, errors: 0, ms: [] };
    try { save(); } catch (e) { console.log(`  search runner: save failed: ${e.message}`); }
  }, 300e3);

  // Slot time (ms, all slots): in pages, held by the gap, waiting on a new session. The rest of
  // slots × run time is idle (queue done or too near the deadline to start a page). Says which
  // limit binds: the gap, Google's page time, or neither.
  const slot = { page: 0, gap: 0, renew: 0 };
  let i = 0;
  const worker = async () => {
    while (i < queue.length && Date.now() + PAGE_MS / 2 < until) {
      const s = queue[i++];
      // Paced: a page started every `gap` ms at most, across the slots.
      const wait = next - Date.now();
      next = Math.max(next, Date.now()) + gap;
      const tw = Date.now();
      await sleep(wait);
      const tr = Date.now();
      slot.gap += tr - tw;
      if (renewing) await renewing;
      slot.renew += Date.now() - tr;
      if (++sessionPages >= sessionMax) {
        renewing ??= b.renew().then(() => { sessions++; sessionPages = 0; }, (e) => console.log(`  new session failed: ${e.message}`)).finally(() => { renewing = null; });
      }
      const t1 = Date.now();
      try {
        const list = dedupe((await b.shoppingResults(s.q, { timeout: PAGE_MS })).flatMap(parseResults));
        const when = stamp();
        if (list.length) { for (const k of s.keys) rows.push([k, when, list]); all.rows++; }
        else { all.empty++; win.empty++; if (s.had) { all.emptyHad++; win.emptyHad++; } }
      } catch (e) {
        all.errors++; win.errors++;
        const why = e.message.replace(/\d+/g, 'N').slice(0, 80);
        all.why[why] = (all.why[why] ?? 0) + 1;
      } finally {
        const ms = Date.now() - t1;
        slot.page += ms;
        all.pages++; win.pages++; all.ms.push(ms); win.ms.push(ms);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: slots }, worker));
  } finally {
    clearInterval(tick);
    save();
    // "View more flights" (the full list): browser.js moreTally.
    const t = await b.tally().catch(() => null);
    if (t) console.log(`search runner: more flights ${JSON.stringify(t.more)}; replies ${JSON.stringify(t.bgr)}`);
    for (const line of t?.pages ?? []) console.log(`search runner, ${line}`);
    await b.close();
  }
  const secs = (Date.now() - started) / 1000;
  const slotMs = slots * secs * 1000;
  const share = (ms) => `${Math.round((100 * ms) / slotMs)}%`;
  console.log(`search runner, slot time (${slots} slots × ${Math.round(secs)} s): pages ${share(slot.page)}, held by the ${gap} ms gap ${share(slot.gap)}, waiting on a new session ${share(slot.renew)}, idle ${share(slotMs - slot.page - slot.gap - slot.renew)}`);
  console.log(`search runner: ${all.pages} of ${queue.length} searched in ${Math.round(secs)} s (${(all.pages / secs).toFixed(2)} a second), ${all.rows} with flights, ${all.empty} listing nothing (${all.emptyHad} of them listed flights before), ${all.errors} errors; page ${pct(all.ms, 0.5)} median, ${pct(all.ms, 0.9)} p90; ${sessions} new sessions; ${rows.length} cache rows to ${out}`);
  const why = Object.entries(all.why).sort((a, b) => b[1] - a[1]);
  if (why.length) console.log(`search runner: errors by kind: ${why.slice(0, 6).map(([w, n]) => `${n}× ${w}`).join('; ')}`);
})().catch((e) => { console.log(`search runner failed: ${e.stack ?? e.message}`); process.exitCode = 1; });
