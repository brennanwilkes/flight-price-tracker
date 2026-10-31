// History tab: the board's top routes over time, from derived/history/<YYYY-MM>.csv (a row whenever
// a cell's total changes). Business and economy sit an order of magnitude apart, so each class
// gets its own chart (one axis each); in each, the class's MAX_SERIES cheapest routes in the
// board's current view, one stepped line per route (a price holds until the next change).
// History is kept per route overall, so the month and via filters pick the routes, not the values.
// Chart.js is loaded from cdnjs the first time the tab opens.
import { cityName } from './cities.js';

const CHART_JS = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const FIRST_MONTH = '2026-10'; // the first history file
const MAX_SERIES = 8; // the categorical palette's size; more lines stop being tellable apart
const CLASSES = [['hybrid', 'Business'], ['economy', 'Economy']];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const money = (n) => `$${Math.round(n).toLocaleString('en-CA')}`;
const fmtDates = (t) => `${new Date(`${t.depart}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${new Date(`${t.ret}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
const label = (r) => (r.in === r.out ? cityName(r.in) : `${cityName(r.in)} / ${cityName(r.out)}`);

let chartJs = null;
const loadChartJs = () => (chartJs ??= new Promise((ok, fail) => {
  const s = document.createElement('script');
  s.src = CHART_JS;
  s.onload = () => ok(window.Chart);
  s.onerror = () => { chartJs = null; fail(new Error('Chart.js didn\'t load')); };
  document.head.appendChild(s);
}));

const cache = new Map(); // base → Promise<Map("home,cls,in,out" → [[ms, total|null]])>
function loadHistory(base) {
  if (cache.has(base)) return cache.get(base);
  const months = [];
  for (let d = new Date(`${FIRST_MONTH}-01T00:00:00Z`); d <= new Date(); d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
  const p = Promise.all(months.map((m) => fetch(`${base}/derived/history/${m}.csv`, { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : ''), () => ''))).then((texts) => {
    const series = new Map();
    for (const text of texts) {
      for (const line of text.trim().split('\n').slice(1)) {
        const [at, home, cls, inn, out, total] = line.split(',');
        const key = `${home},${cls},${inn},${out}`;
        if (!series.has(key)) series.set(key, []);
        series.get(key).push([Date.parse(at), total === '' ? null : Number(total)]);
      }
    }
    return series;
  });
  cache.set(base, p);
  return p;
}

/** Every series on one time grid (each change time, then now), value held between changes, so the
 * hover tooltip (index mode) lines all routes up at the same moment. */
function onGrid(list) {
  const times = [...new Set(list.flatMap((pts) => pts.map(([t]) => t)))].sort((a, b) => a - b);
  times.push(Date.now());
  return {
    times,
    values: list.map((pts) => {
      let i = -1;
      return times.map((t) => {
        while (i + 1 < pts.length && pts[i + 1][0] <= t) i++;
        return i < 0 ? null : pts[i][1];
      });
    }),
  };
}

const charts = [];

/** Render the tab into `el`. rows: the board's rows in its current view (home, month, via); the priority class's chart first. */
export async function renderHistory(el, base, home, rows, priority = 'hybrid') {
  el.innerHTML = '<p class="note">Loading…</p>';
  let Chart, series;
  try { [Chart, series] = await Promise.all([loadChartJs(), loadHistory(base)]); } catch (e) {
    el.innerHTML = `<p class="note">Couldn't load the history: ${esc(e.message)}</p>`;
    return;
  }
  const picks = CLASSES.slice().sort(([a]) => (a === priority ? -1 : 1)).map(([cls, name]) => {
    const top = rows.filter((r) => r.cells[cls]).sort((a, b) => a.cells[cls].total - b.cells[cls].total).slice(0, MAX_SERIES)
      .map((r) => ({ r, pts: series.get(`${home},${cls},${r.in},${r.out}`) ?? [] })).filter((x) => x.pts.length);
    return { cls, name, top };
  });
  el.innerHTML = picks.map(({ cls, name, top }) => `
    <section class="panel chart">
      <h3>${name}</h3>
      ${top.length ? `<div class="chart-box"><canvas data-cls="${cls}" role="img" aria-label="${name}: cheapest trip over time, top ${top.length} routes"></canvas></div>
      <ol class="legend">${top.map(({ r }, i) => `
        <li><button type="button" data-cls="${cls}" data-i="${i}" aria-pressed="true"><i style="background: var(--s${i + 1})"></i><span>${esc(label(r))}</span><b>${money(r.cells[cls].total)}</b></button></li>`).join('')}
      </ol>` : '<p class="note">No history yet.</p>'}
    </section>`).join('');

  for (const c of charts.splice(0)) c.destroy();
  const css = getComputedStyle(document.documentElement);
  const tok = (v) => css.getPropertyValue(v).trim();
  const fmtTime = (ms) => new Date(ms).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  for (const { cls, top } of picks) {
    const canvas = el.querySelector(`canvas[data-cls="${cls}"]`);
    if (!canvas) continue;
    const { times, values } = onGrid(top.map((x) => x.pts));
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: top.map(({ r, pts }, i) => ({
          label: label(r), route: { trip: r.cells[cls], vals: pts.map(([, v]) => v).filter((v) => v != null) }, data: values[i].map((y, j) => ({ x: times[j], y })), stepped: true, borderColor: tok(`--s${i + 1}`), borderWidth: 2,
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
              title: (items) => items[0].dataset.label,
              label: (item) => ` ${item.parsed.y == null ? 'no trip' : money(item.parsed.y)} on ${fmtTime(item.parsed.x)}`,
              afterBody: (items) => {
                const { trip, vals } = items[0].dataset.route;
                return [
                  '',
                  `Now   ${money(trip.total)} · ${fmtDates(trip)}`,
                  `Low   ${money(Math.min(...vals))}`,
                  `High  ${money(Math.max(...vals))}`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear', min: times[0], max: times.at(-1), grid: { display: false }, border: { color: tok('--line') },
            ticks: {
              color: tok('--muted'), font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 5, maxRotation: 0,
              // Times while the history is under two days long, dates after.
              callback(v) {
                return this.max - this.min < 2 * 864e5
                  ? new Date(v).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false })
                  : new Date(v).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
              },
            },
          },
          y: { grid: { color: tok('--line') }, border: { display: false }, ticks: { color: tok('--muted'), font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 5, callback: (v) => money(v) } },
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
  // Legend entries toggle their line.
  for (const b of el.querySelectorAll('.legend button')) {
    b.addEventListener('click', () => {
      const chart = charts.find((c) => c.canvas.dataset.cls === b.dataset.cls);
      const on = b.getAttribute('aria-pressed') !== 'true';
      chart.setDatasetVisibility(Number(b.dataset.i), on);
      chart.update();
      b.setAttribute('aria-pressed', String(on));
    });
  }
}
