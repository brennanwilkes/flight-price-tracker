// History tab: one route's cheapest trip over time, from derived/history/<YYYY-MM>.csv (a row
// whenever a cell's total changes). Business and economy sit an order of magnitude apart, so each
// gets its own chart (one axis each), drawn as steps: a price holds until the next change.
// Chart.js is loaded from cdnjs the first time the tab opens.
import { cityName } from './cities.js';

const CHART_JS = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const FIRST_MONTH = '2026-10'; // the first history file
const CLASSES = [['hybrid', 'Business', '--amber'], ['economy', 'Economy', '--text']];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const money = (n) => `$${Math.round(n).toLocaleString('en-CA')}`;
const label = (inn, out) => (inn === out ? cityName(inn) : `${cityName(inn)} / ${cityName(out)}`);

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

const charts = [];

/**
 * Render the tab into `el`. rows: the board's rows for this home (route picker, cheapest first);
 * route: "IN-OUT" or null for the first; onRoute(route) when another is picked.
 */
export async function renderHistory(el, base, home, rows, route, onRoute) {
  el.innerHTML = '<p class="note">Loading…</p>';
  const key = route && rows.some((r) => `${r.in}-${r.out}` === route) ? route : rows[0] && `${rows[0].in}-${rows[0].out}`;
  if (!key) { el.innerHTML = '<p class="note">No trips yet.</p>'; return; }
  let Chart, series;
  try { [Chart, series] = await Promise.all([loadChartJs(), loadHistory(base)]); } catch (e) {
    el.innerHTML = `<p class="note">Couldn't load the history: ${esc(e.message)}</p>`;
    return;
  }
  const [inn, out] = key.split('-');
  el.innerHTML = `
    <select class="route-pick" aria-label="Route">${rows.map((r) => `<option value="${r.in}-${r.out}"${`${r.in}-${r.out}` === key ? ' selected' : ''}>${esc(label(r.in, r.out))}</option>`).join('')}</select>
    ${CLASSES.map(([cls, name]) => {
      const pts = series.get(`${home},${cls},${inn},${out}`) ?? [];
      const vals = pts.map(([, v]) => v).filter((v) => v != null);
      return `<section class="panel chart">
        <div class="chart-head"><h3>${name}</h3>${vals.length ? `<span><small>Now</small><b>${money(vals.at(-1))}</b></span><span><small>Low</small><b>${money(Math.min(...vals))}</b></span><span><small>High</small><b>${money(Math.max(...vals))}</b></span>` : ''}</div>
        ${vals.length ? `<div class="chart-box"><canvas data-cls="${cls}" role="img" aria-label="${name} price over time"></canvas></div>` : '<p class="note">No history yet.</p>'}
      </section>`;
    }).join('')}`;
  el.querySelector('.route-pick').addEventListener('change', (e) => onRoute(e.target.value));

  for (const c of charts.splice(0)) c.destroy();
  const css = getComputedStyle(document.documentElement);
  const tok = (v) => css.getPropertyValue(v).trim();
  const fmtTime = (ms) => new Date(ms).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  for (const canvas of el.querySelectorAll('canvas')) {
    const [, , colour] = CLASSES.find(([c]) => c === canvas.dataset.cls);
    const pts = series.get(`${home},${canvas.dataset.cls},${inn},${out}`);
    // Hold the last value to now, so the line reaches the present.
    const data = [...pts.map(([x, y]) => ({ x, y })), { x: Date.now(), y: pts.at(-1)[1] }];
    charts.push(new Chart(canvas, {
      type: 'line',
      data: { datasets: [{ data, stepped: true, borderColor: tok(colour), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: tok(colour), pointHoverBorderColor: tok('--panel'), pointHoverBorderWidth: 2, spanGaps: false }] },
      options: {
        animation: false,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false, backgroundColor: tok('--cell'), titleColor: tok('--muted'), bodyColor: tok('--text'), borderColor: tok('--line'), borderWidth: 1,
            titleFont: { family: 'JetBrains Mono', size: 11 }, bodyFont: { family: 'JetBrains Mono', size: 13, weight: '700' },
            callbacks: { title: (items) => fmtTime(items[0].parsed.x), label: (item) => (item.parsed.y == null ? 'no trip' : money(item.parsed.y)) },
          },
        },
        scales: {
          x: {
            type: 'linear', grid: { display: false }, border: { color: tok('--line') },
            ticks: { color: tok('--muted'), font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 5, maxRotation: 0,
              // Times while the history is under two days long, dates after.
              callback(v) {
                return this.max - this.min < 2 * 864e5
                  ? new Date(v).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false })
                  : new Date(v).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
              } },
          },
          y: {
            grid: { color: tok('--line') }, border: { display: false },
            ticks: { color: tok('--muted'), font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 5, callback: (v) => money(v) },
          },
        },
      },
    }));
  }
}
