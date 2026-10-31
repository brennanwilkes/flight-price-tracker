// Health tab: is the scraper running, are alerts reaching the phone, how fresh is each route.
// Reads the data branch at the dashboard's commit (state/health.json, state/alerts.json,
// derived/status.json) and the Worker's push health (alerts.js).
import { alertState, subscribe, requestSweep } from './alerts.js';
import { cityName } from './cities.js';

const STALE_H = 48; // a route with cells older than this is falling behind (fares.js drops them)
const ALERT_WORD = { on: 'On', off: 'Off', failing: 'Failing', install: 'Install first', unsupported: 'Not supported', unreachable: 'Unreachable' };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const money = (n) => `$${n.toLocaleString('en-CA')}`;
const num = (n) => n.toLocaleString('en-CA');
const hours = (iso) => (Date.now() - Date.parse(iso)) / 36e5;
const ago = (iso) => {
  if (!iso) return '—';
  const h = hours(iso);
  return h < 1 ? `${Math.max(1, Math.round(h * 60))}m ago` : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
};
const when = (iso) => new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
const box = (label, value, cls = '') => `<div class="box ${cls}"><small>${label}</small><b>${value}</b></div>`;

async function get(base, file) {
  try {
    const res = await fetch(`${base}/${file}`, { cache: 'no-cache' });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/**
 * Render the tab into `el`; base: the data branch at the dashboard's commit. settings:
 * { priority, setPriority(p) } for the priority switch.
 */
export async function renderHealth(el, base, settings) {
  el.innerHTML = '<p class="note">Loading…</p>';
  const [health, ledger, status, alerts] = await Promise.all([
    get(base, 'state/health.json'), get(base, 'state/alerts.json'), get(base, 'derived/status.json'), alertState(),
  ]);
  const runs = health?.runs ?? [];
  const last = runs[0];
  const failing = health?.consecutiveFailures ?? 0;
  const routes = status?.routes ?? [];
  const stale = routes.filter((r) => !r.newest || hours(r.newest) > STALE_H);
  const d = status?.details;
  const a = status?.alerts;
  const deals = Object.entries(ledger?.deals ?? {}).sort((x, y) => y[1].at.localeCompare(x[1].at)).slice(0, 6);

  el.innerHTML = `
    <h3>Priority</h3>
    <div class="seg prio" role="radiogroup" aria-label="Priority class">
      ${[['hybrid', 'Business'], ['economy', 'Economy']].map(([c, name]) => `<button type="button" role="radio" data-prio="${c}" aria-checked="${c === settings.priority}">${name}</button>`).join('')}
    </div>
    <p class="hint">On this device: sorts the board, opens trips, leads History.</p>

    <h3>Scraper</h3>
    <div class="grid">
      ${box('Last sweep', last ? ago(last.at) : '—', last && !last.success ? 'bad' : '')}
      ${box('Status', failing ? `Failing ×${failing}` : last ? 'OK' : '—', failing ? 'bad' : 'good')}
      ${box('Combos', last ? `${last.ok}/${last.ok + last.failed}` : '—')}
      ${box('Stale routes', `${stale.length}/${routes.length}`, stale.length ? 'bad' : '')}
    </div>

    <h3>Alerts</h3>
    <div class="grid">
      ${box('Push', ALERT_WORD[alerts.state], alerts.state === 'on' ? 'good' : 'bad')}
      ${box('Last', alerts.detail ? esc(alerts.detail.replace(/^last push /, '')) : '—')}
    </div>
    <div class="actions">
      ${alerts.canEnable ? `<button type="button" data-act="enable">${alerts.state === 'on' ? 'Re-subscribe this phone' : 'Enable alerts'}</button>` : ''}
      <button type="button" data-act="sweep">Scrape everything now</button>
      <p class="result" hidden></p>
    </div>
    ${deals.length ? `<ol class="rows">${deals.map(([key, x]) => {
      const [home, cls, inn, out] = key.split(',');
      return `<li><span>${when(x.at)}</span><span>${esc(inn === out ? cityName(inn) : `${cityName(inn)} / ${cityName(out)}`)}${cls === 'hybrid' ? ' · J' : ''}${home !== 'YVR' ? ` · ${home}` : ''}</span><b>${money(x.total)}</b></li>`;
    }).join('')}</ol>` : ''}

    ${a ? `<h3>Alert when</h3>
    <div class="grid">
      ${box('Business ≤', money(a.tiers.hybrid[0][0]))}
      ${box('Economy ≤', money(a.tiers.economy[0][0]))}
      ${box('J long flights <', money(a.cheapBusinessLongLegs))}
      ${box('New low after', `${a.newLowWarmupDays} days`)}
      ${box('Again after', `−${money(a.realertDrop.cad)} / ${a.realertDrop.share * 100}%`)}
      ${box('Max per sweep', a.maxPushesPerRun)}
    </div>` : ''}

    <h3>Sweeps</h3>
    <div class="runs">${runs.map((r) => {
      const cells = `<span>${when(r.at)}</span><span>${r.ok}/${r.ok + r.failed}</span><span>${Math.round(r.seconds / 60)}m</span><b>${r.success ? 'OK' : 'FAIL'}${r.errors?.length ? ` <i>${r.errors.length}</i>` : ''}</b>`;
      return r.errors?.length
        ? `<details class="run${r.success ? '' : ' bad'}"><summary>${cells}</summary>${r.errors.map((e) => `<pre>${esc(e.split('\n')[0])}</pre>`).join('')}</details>`
        : `<div class="run${r.success ? '' : ' bad'}"><div class="summary">${cells}</div></div>`;
    }).join('')}</div>

    ${d ? `<h3>Flight checks</h3>
    <div class="grid">
      ${box('Cells', num(d.cells))}
      ${box('Searches', `${num(d.searches)}${d.failed ? ` · ${d.failed} failed` : ''}`, d.failed ? 'bad' : '')}
      ${box('Rerouted', num(d.replaced))}
      ${box('No connection', num(d.unresolved))}
    </div>` : ''}

    <h3>Routes</h3>
    <details class="rows-fold"><summary><span>${routes.length} routes</span><b>${ago(routes.map((r) => r.newest).filter(Boolean).sort().at(-1))}</b></summary>
      <ol class="rows">${routes.slice().sort((x, y) => (x.newest ?? '').localeCompare(y.newest ?? '')).map((r) => `
        <li class="${!r.newest || hours(r.newest) > STALE_H ? 'bad' : ''}"><span>${r.route}</span><span>${r.cells}</span><b>${ago(r.newest)}</b></li>`).join('')}
      </ol>
    </details>`;

  for (const b of el.querySelectorAll('[data-prio]')) {
    b.addEventListener('click', () => {
      for (const x of el.querySelectorAll('[data-prio]')) x.setAttribute('aria-checked', String(x === b));
      settings.setPriority(b.dataset.prio);
    });
  }
  const result = el.querySelector('.result');
  const act = async (b, fn) => {
    b.disabled = true;
    result.hidden = false;
    try { result.textContent = (await fn()) ?? ''; } catch (e) { result.textContent = e.message; }
    b.disabled = false;
  };
  el.querySelector('[data-act="enable"]')?.addEventListener('click', (e) => act(e.target, async () => { await subscribe(); renderHealth(el, base, settings); }));
  el.querySelector('[data-act="sweep"]').addEventListener('click', (e) => act(e.target, requestSweep));
}
