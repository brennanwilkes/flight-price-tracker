// History tab: the board's top routes over time, from derived/history-days-<HOME>.json (each
// cell's daily low, from the build's derived/history/*.csv: a row whenever a cell's total changes).
// Business and economy sit an order of magnitude apart, so each class
// gets its own chart (one axis each); in each, the MAX_SERIES long-haul pairs (in, out) with the
// lowest prices ever recorded, one line per pair, its rows with throw-ins folded in (the
// cheapest at each moment; a price holds until the next change). Drawn one point a day, the
// day's low (local days): hourly changes made the lines unreadable. History is kept per
// route overall (the board's own cells), so the month filter picks the routes, not the values;
// under a via filter, only the routes whose overall trip is the via view's (the line is its price).
// Chart.js is loaded from cdnjs the first time the tab opens.
import { rowName } from './cities.js';

const CHART_JS = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const MAX_SERIES = 8; // the categorical palette's size; more lines stop being tellable apart
const CLASSES = [['hybrid', 'Business'], ['economy', 'Economy']];
// Fixed y ranges, so the axis holds still as lines are shown and hidden; a price outside runs
// along the edge, dashed.
const RANGE = { hybrid: [3000, 6000], economy: [500, 2000] };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const money = (n) => `$${Math.round(n).toLocaleString('en-CA')}`;
const fmtDates = (t) => `${new Date(`${t.depart}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${new Date(`${t.ret}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
// A board row as the files key it: "in,out", out with the row's throw-ins ("DPS+HAN").
const routeOf = (r) => `${r.in},${r.out}${r.set ? `+${r.set}` : ''}`;

let chartJs = null;
const loadChartJs = () => (chartJs ??= new Promise((ok, fail) => {
  const s = document.createElement('script');
  s.src = CHART_JS;
  s.onload = () => ok(window.Chart);
  s.onerror = () => { chartJs = null; fail(new Error('Chart.js didn\'t load')); };
  document.head.appendChild(s);
}));

// The build's daily lows (derived/history-days-<HOME>.json, scraper/src/trips/history.js
// writeHistoryDays): "cls,in,out[+set]" → [first day, last day if gone else null, [low|null a day]],
// days since 1970 in Vancouver (UTC-7). Replaced replaying every history row here (62 MB, Nov 24).
const VAN_MS = 7 * 3600e3;
const dayMs = (d) => d * 864e5 + VAN_MS; // that day's Vancouver midnight
const cache = new Map(); // base|home → Promise<{ keys }>
function loadHistory(base, home) {
  const k = `${base}|${home}`;
  if (cache.has(k)) return cache.get(k);
  const p = fetch(`${base}/derived/history-days-${home}.json`, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  p.catch(() => cache.delete(k));
  cache.set(k, p);
  return p;
}

/** A pair's rows (members: { r, s, last, v }) as one value a day over `days`: the cheapest live low
 * among them, with the row that had it. None live: held at the last low (dashed) while any row
 * still stands; nothing once every row is gone, or before the first. */
function pairDays(members, days) {
  let last = null;
  return days.map((d) => {
    let y = null, who = null, standing = false;
    for (const m of members) {
      if (d < m.s) continue;
      const v = m.v[Math.min(d - m.s, m.v.length - 1)];
      if (v != null) { if (y == null || v < y) { y = v; who = m.r; } continue; }
      if (m.last == null || d < m.last) standing = true;
    }
    if (y != null) { last = y; return { y, held: false, who }; }
    return standing && last != null ? { y: last, held: true, who: null } : { y: null, held: false, who: null };
  });
}

const charts = [];

/**
 * Render the tab into `el`; the priority class's chart first. view: { rows: the board's rows in its
 * current view (month, via), all: every row on the board, via: a via filter is on, main: the
 * unfiltered board's rows }. A route on the
 * board shows when it has a trip in the view; one no longer on the board, unless a via filter is on.
 */
export async function renderHistory(el, base, home, view, priority = 'hybrid', live = () => true) {
  el.innerHTML = '<p class="note">Loading…</p>';
  let Chart, series;
  try { [Chart, series] = await Promise.all([loadChartJs(), loadHistory(base, home).then((h) => Object.entries(h.keys ?? {}))]); } catch (e) {
    if (live()) el.innerHTML = `<p class="note">Couldn't load the history: ${esc(e.message)}</p>`;
    return;
  }
  if (!live()) return; // another tab (or render) since: leave its page alone
  const picks = CLASSES.slice().sort(([a]) => (a === priority ? -1 : 1)).map(([cls, name]) => {
    const shown = new Map(view.rows.map((r) => [routeOf(r), r.cells[cls]]));
    const onBoard = new Set(view.all.map(routeOf));
    // Via filter: the route's history is its overall cheapest trip's; shown only where that trip is
    // the one in the via view (seen: a route's overall $6,440 beside its via cell's other price).
    const overall = new Map((view.main ?? []).map((r) => [routeOf(r), r[cls]]));
    const same = (route) => !view.via || overall.get(route)?.total === shown.get(route)?.total;
    const routes = series.flatMap(([key, [s, last, v]]) => {
      const [c, inn, ends] = key.split(',');
      if (c !== cls) return [];
      const route = `${inn},${ends}`;
      const [out, ...set] = ends.split('+');
      const low = Math.min(...v.map((y) => y ?? Infinity));
      if (low === Infinity) return [];
      if ((onBoard.has(route) || view.via) && (!shown.get(route) || !same(route))) return [];
      return [{ r: { in: inn, out, set: set.join('+') }, trip: shown.get(route), s, last, v, low }];
    });
    // One line per long-haul pair (in, out), its throw-in rows folded in: the cheapest of them at
    // each moment. Otherwise one headline pair filled the chart with its throw-in combinations.
    const pairs = new Map();
    for (const x of routes) {
      const k = `${x.r.in},${x.r.out}`;
      if (!pairs.has(k)) pairs.set(k, { r: { in: x.r.in, out: x.r.out, set: '' }, members: [], low: Infinity, trip: null });
      const p = pairs.get(k);
      p.members.push(x);
      p.low = Math.min(p.low, x.low);
      if (x.trip && (!p.trip || x.trip.total < p.trip.total)) { p.trip = x.trip; p.tripOf = x.r; }
    }
    const top = [...pairs.values()].sort((a, b) => a.low - b.low).slice(0, MAX_SERIES);
    return { cls, name, top };
  });
  el.innerHTML = picks.map(({ cls, name, top }) => `
    <section class="panel chart">
      <h3>${name}</h3>
      ${top.length ? `<div class="chart-box"><canvas data-cls="${cls}" role="img" aria-label="${name}: cheapest trip over time, top ${top.length} routes"></canvas></div>
      <ol class="legend">${top.map(({ r, low }, i) => `
        <li><button type="button" data-cls="${cls}" data-i="${i}" aria-pressed="true"><i style="background: var(--s${i + 1})"></i><span>${esc(rowName(r))}</span><b>${money(low)}</b></button></li>`).join('')}
      </ol>` : `<p class="note">${view.via ? 'No history for these via cities.' : 'No history yet.'}</p>`}
    </section>`).join('');

  for (const c of charts.splice(0)) c.destroy();
  const css = getComputedStyle(document.documentElement);
  const tok = (v) => css.getPropertyValue(v).trim();
  for (const { cls, top } of picks) {
    const canvas = el.querySelector(`canvas[data-cls="${cls}"]`);
    if (!canvas) continue;
    const d0 = Math.min(...top.flatMap((x) => x.members.map((m) => m.s)));
    const d1 = Math.max(...top.flatMap((x) => x.members.map((m) => m.s + m.v.length - 1)));
    const grid = Array.from({ length: Math.max(1, d1 - d0 + 1) }, (_, j) => d0 + j);
    const times = grid.map(dayMs);
    const days = top.map(({ members }) => pairDays(members, grid));
    const [lo, hi] = RANGE[cls];
    const clip = (y) => (y == null ? null : Math.min(hi, Math.max(lo, y)));
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: top.map(({ r, trip, tripOf }, i) => ({
          label: rowName(r), route: { trip, tripOf }, data: days[i].map((v, j) => ({ x: times[j], y: clip(v.y), price: v.y, who: v.who })),
          cubicInterpolationMode: 'monotone', borderColor: tok(`--s${i + 1}`), borderWidth: 2,
          segment: { borderDash: (ctx) => (days[i][ctx.p1DataIndex].held || clip(days[i][ctx.p0DataIndex].y) !== days[i][ctx.p0DataIndex].y ? [4, 4] : undefined) },
          pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: tok(`--s${i + 1}`), pointHoverBorderColor: tok('--panel'), pointHoverBorderWidth: 2,
        })),
      },
      options: {
        animation: false,
        maintainAspectRatio: false,
        // One route per tooltip: the line nearest the tap.
        interaction: { mode: 'nearest', axis: 'xy', intersect: false },
        plugins: {
          legend: { display: false }, // the HTML legend below names every line
          tooltip: {
            backgroundColor: tok('--cell'), titleColor: tok('--text'), bodyColor: tok('--text'), borderColor: tok('--line'), borderWidth: 1,
            boxWidth: 8, boxHeight: 8, usePointStyle: true,
            titleFont: { family: 'JetBrains Mono', size: 12, weight: '700' }, bodyFont: { family: 'JetBrains Mono', size: 12 },
            callbacks: {
              // The pair and its lowest price that day, with the row (throw-ins) that had it;
              // then its cheapest row now and that trip's dates (history keeps prices, not dates).
              title: (items) => `${items[0].dataset.label}  ${items[0].raw.price == null ? '—' : money(items[0].raw.price)}`,
              label: (item) => [
                `${new Date(item.raw.x).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}, the day's low`,
                item.raw.who?.set ? `then: ${rowName(item.raw.who)}` : '',
                item.dataset.route.trip ? `now: ${item.dataset.route.tripOf?.set ? `${rowName(item.dataset.route.tripOf)}, ` : ''}${fmtDates(item.dataset.route.trip)}` : '',
              ].filter(Boolean),
            },
          },
        },
        scales: {
          x: {
            type: 'linear', min: times[0], max: Math.max(times.at(-1), times[0] + 864e5), grid: { display: false }, border: { color: tok('--line') },
            // A tick at each midnight (at most 6, evenly thinned), labelled with the day.
            afterBuildTicks(axis) {
              const days = [];
              const d = new Date(axis.min);
              d.setHours(0, 0, 0, 0);
              if (d.getTime() < axis.min) d.setDate(d.getDate() + 1);
              for (; d.getTime() <= axis.max; d.setDate(d.getDate() + 1)) days.push({ value: d.getTime() });
              const step = Math.ceil(days.length / 6);
              axis.ticks = days.length ? days.filter((_, i) => i % step === 0) : [{ value: axis.min }];
            },
            ticks: {
              color: tok('--muted'), font: { family: 'JetBrains Mono', size: 10 }, maxRotation: 0, autoSkip: false,
              callback: (v) => new Date(v).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }),
            },
          },
          y: { min: lo, max: hi, grid: { color: tok('--line') }, border: { display: false }, ticks: { color: tok('--muted'), font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 5, callback: (v) => money(v) } },
        },
      },
    });
    charts.push(chart);
  }
  // A tap anywhere but a chart closes any open tooltip (touch leaves them up otherwise).
  if (!el.dataset.dismiss) {
    el.dataset.dismiss = '1';
    document.addEventListener('click', (e) => {
      if (e.target.closest('canvas')) return;
      for (const c of charts) {
        if (!c.tooltip?.getActiveElements().length) continue;
        c.tooltip.setActiveElements([], { x: 0, y: 0 });
        c.setActiveElements([]);
        c.update();
      }
    });
  }
  // A legend entry shows only its line; tapping it again while it's alone brings the rest back.
  for (const b of el.querySelectorAll('.legend button')) {
    b.addEventListener('click', () => {
      const chart = charts.find((c) => c.canvas.dataset.cls === b.dataset.cls);
      const all = [...b.closest('.legend').querySelectorAll('button')];
      const alone = all.every((x) => (x.getAttribute('aria-pressed') === 'true') === (x === b));
      for (const x of all) {
        const on = alone || x === b;
        chart.setDatasetVisibility(Number(x.dataset.i), on);
        x.setAttribute('aria-pressed', String(on));
      }
      chart.update();
    });
  }
}
