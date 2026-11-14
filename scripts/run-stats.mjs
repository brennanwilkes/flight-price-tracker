#!/usr/bin/env node
// Saturation numbers from the last N Sweep runs' logs, and projections computed from all of them
// (a least-squares trend), not from one run's change: one-run deltas gave wrong ETAs (the "3 pm
// Nov 14" estimate). Times are Vancouver (UTC−7).
//
//   node scripts/run-stats.mjs [N=8] [--cache DIR] [--detail]
//
// Logs are cached in DIR (default ~/.cache/flight-run-logs; a finished run's log never changes).
// --detail prints the newest run's telemetry lines (page phases and CPU, slot time, CPU by kind).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 8);
const ci = args.indexOf('--cache');
const dir = ci >= 0 ? args[ci + 1] : path.join(os.homedir(), '.cache', 'flight-run-logs');
fs.mkdirSync(dir, { recursive: true });

const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 30 });
const runs = JSON.parse(gh('run', 'list', '-w', 'Sweep', '-L', String(N + 3), '--json', 'databaseId,createdAt,status,conclusion,headSha'))
  .filter((r) => r.status === 'completed').slice(0, N).reverse();

const van = (iso) => new Date(Date.parse(iso) - 7 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
const num = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));
const m = (log, re) => log.match(re);

const rows = runs.map((r) => {
  const f = path.join(dir, `${r.databaseId}.log`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, gh('run', 'view', String(r.databaseId), '--log'));
  // Strip the "job\tstep\ttimestamp " prefix of each line.
  const log = fs.readFileSync(f, 'utf8').split('\n').map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+ /, '')).join('\n');
  const g = (re, i = 1) => num(m(log, re)?.[i]);
  return {
    id: r.databaseId, at: r.createdAt, when: van(r.createdAt), ok: r.conclusion, sha: r.headSha.slice(0, 7), log,
    boardDone: g(/booking runner, board: (\d+) of/), boardDue: g(/booking runner, board: \d+ of (\d+)/),
    tiesPages: g(/booking runner, unchecked dates: .*?; (\d+) booking pages/),
    filtersDone: g(/booking runner, filters: (\d+) of/),
    boardN: g(/booking queue: (\d+) board itineraries/), boardFresh: g(/booking queue: \d+ board itineraries \((\d+)/),
    filtersN: g(/booking queue: .*?, (\d+) filters'/), filtersFresh: g(/booking queue: .*?, \d+ filters' \((\d+)\)/),
    searched: g(/(\d+) of \d+ searched in/), lost: g(/more flights \{[^}]*"lost":(\d+)/),
    backlog: g(/search queue: \d+ browser searches for the search runner \((\d+) left/),
    hidden: g(/priced as listed: (\d+) cells hidden/),
    used: g(/search demand: (\d+) searches used/), needSearch: g(/that takes (\d+) a run/),
    neverSearched: g(/search demand: .*?(\d+) never searched/),
    cpu: m(log, /CPU averages over .*/)?.[0], load: m(log, /load \(1 min\) average .*/)?.[0],
  };
});

const pad = (v, w) => String(v ?? '-').padStart(w);
console.log(`Last ${rows.length} runs (Vancouver time):`);
console.log('run          board  ties filters  filt.fresh  board.fresh searched lost backlog hidden');
for (const r of rows) {
  console.log(`${r.when} ${pad(r.boardDone, 4)}/${pad(r.boardDue, 4)} ${pad(r.tiesPages, 4)} ${pad(r.filtersDone, 6)} ${pad(r.filtersFresh, 5)}/${pad(r.filtersN, 5)} ${pad(r.boardFresh, 5)}/${pad(r.boardN, 5)} ${pad(r.searched, 7)} ${pad(r.lost, 4)} ${pad(r.backlog, 7)} ${pad(r.hidden, 6)}`);
}

// Least-squares slope per run of a series (nulls skipped), and the run count to reach `target`.
function trend(key) {
  const pts = rows.map((r, i) => [i, r[key]]).filter(([, v]) => v != null);
  if (pts.length < 3) return null;
  const n = pts.length, sx = pts.reduce((a, [x]) => a + x, 0), sy = pts.reduce((a, [, y]) => a + y, 0);
  const sxx = pts.reduce((a, [x]) => a + x * x, 0), sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const last = pts.at(-1)[1];
  return { slope, last, n };
}
const eta = (runsAway) => {
  const lastAt = Date.parse(rows.at(-1).at);
  return van(new Date(lastAt + runsAway * 3600e3).toISOString());
};
const avg = (key) => { const v = rows.map((r) => r[key]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

console.log('\nProjections (trend over these runs; one run an hour):');
const ff = trend('filtersFresh'), fN = rows.at(-1).filtersN;
if (ff) console.log(`  filters fresh: ${ff.last} of ${fN}, ${ff.slope >= 0 ? '+' : ''}${ff.slope.toFixed(0)} a run → ${ff.slope > 0 ? `all fresh in ~${Math.ceil((fN - ff.last) / ff.slope)} runs (${eta(Math.ceil((fN - ff.last) / ff.slope))})` : 'not converging'}`);
const bl = trend('backlog');
if (bl) console.log(`  search backlog: ${bl.last}, ${bl.slope >= 0 ? '+' : ''}${bl.slope.toFixed(0)} a run → ${bl.slope < 0 ? `drained in ~${Math.ceil(bl.last / -bl.slope)} runs (${eta(Math.ceil(bl.last / -bl.slope))})` : 'not draining'}`);
const hd = trend('hidden');
if (hd) console.log(`  hidden board cells: ${hd.last}, ${hd.slope >= 0 ? '+' : ''}${hd.slope.toFixed(0)} a run → ${hd.slope < 0 ? `0 in ~${Math.ceil(hd.last / -hd.slope)} runs (${eta(Math.ceil(hd.last / -hd.slope))})` : 'not falling'}`);

console.log('\nCapacity (averages over these runs):');
const bookingPages = avg('boardDone') + (avg('tiesPages') ?? 0) + (avg('filtersDone') ?? 0);
const boardNeed = (avg('boardN') ?? 0) / 12, filtNeed = [(avg('filtersN') ?? 0) / 24, (avg('filtersN') ?? 0) / 12];
console.log(`  booking pages: ~${Math.round(bookingPages)} a run (board ${Math.round(avg('boardDone'))}, unchecked dates ${Math.round(avg('tiesPages') ?? 0)}, filters ${Math.round(avg('filtersDone') ?? 0)}); steady state needs board ~${Math.round(boardNeed)} + filters ${Math.round(filtNeed[0])}-${Math.round(filtNeed[1])} + unchecked dates, plus price moves`);
const need = avg('needSearch');
console.log(`  browser searches: ~${Math.round(avg('searched') ?? 0)} a run by the search runner${need ? `; all searches kept fresh need ~${Math.round(need)} a run (plain fetches and the sweep's pages do part)` : ' (search demand logged from the telemetry commit on)'}`);

const last = rows.at(-1);
if (last.cpu || last.load) console.log(`\nNewest run's booking machine: ${[last.load, last.cpu].filter(Boolean).join('; ')}`);
if (args.includes('--detail')) {
  console.log(`\nNewest run (${last.when}) telemetry:`);
  for (const l of last.log.split('\n')) if (/pages: \d+ \(\d+ failed\); time a page|slot time \(|CPU averages|load \(1 min\)|search demand:|booking demand:|more flights \{/.test(l)) console.log(`  ${l.trim()}`);
}
