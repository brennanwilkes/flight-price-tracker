// Health tab: is the scraper running, are alerts reaching the phone, how fresh is each route.
// Reads the data branch at the dashboard's commit (state/health.json, state/alerts.json,
// derived/status.json) and the Worker's push health (via alerts.js).
import { alertsBar, sweepButton } from './alerts.js';
import { cityName } from './cities.js';

const STALE_H = 48; // a route with cells older than this is falling behind (fares.js drops them)

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const money = (n) => `$${n.toLocaleString('en-CA')}`;
const hours = (iso) => (Date.now() - Date.parse(iso)) / 36e5;
const ago = (iso) => {
  if (!iso) return '—';
  const h = hours(iso);
  return h < 1 ? `${Math.max(1, Math.round(h * 60))}m ago` : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
};
const when = (iso) => new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const mins = (s) => `${Math.round(s / 60)}m`;

async function get(base, file) {
  try {
    const res = await fetch(`${base}/${file}`, { cache: 'no-cache' });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

const routeItem = (r) => `<li class="${!r.newest || hours(r.newest) > STALE_H ? 'bad' : ''}"><span class="what">${r.route}</span><span class="when">${r.cells} cells</span><b>${ago(r.newest)}</b></li>`;

/** Render the tab into `el`; base: the data branch at the dashboard's commit. */
export async function renderHealth(el, base) {
  el.innerHTML = '<p class="note">Loading…</p>';
  const [health, ledger, status] = await Promise.all([get(base, 'state/health.json'), get(base, 'state/alerts.json'), get(base, 'derived/status.json')]);
  const last = health?.runs?.[0];
  const failing = health?.consecutiveFailures ?? 0;
  const routes = status?.routes ?? [];
  const stale = routes.filter((r) => !r.newest || hours(r.newest) > STALE_H);
  const d = status?.details;

  el.innerHTML = `
    <section class="panel status ${failing ? 'bad' : 'ok'}">
      <div class="stat"><small>Last sweep</small><b>${last ? ago(last.at) : '—'}</b><span>${last ? (last.success ? 'OK' : 'FAILED') : 'no runs yet'}</span></div>
      <div class="stat"><small>Combos</small><b>${last ? `${last.ok}/${last.ok + last.failed}` : '—'}</b><span>${last ? `${last.priced.toLocaleString('en-CA')} priced` : ''}</span></div>
      <div class="stat"><small>Failing</small><b>${failing}</b><span>runs in a row</span></div>
      <div class="stat"><small>Stale routes</small><b>${stale.length}</b><span>of ${routes.length}</span></div>
    </section>

    <h3>Alerts</h3>
    <section class="panel controls">
      <p id="alerts"></p>
      <p id="sweep"></p>
    </section>
    ${ledger ? `<ol class="list">${Object.entries(ledger.deals).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 8).map(([key, a]) => {
      const [home, cls, inn, out] = key.split(',');
      return `<li><span class="when">${when(a.at)}</span><span class="what">${esc(inn === out ? cityName(inn) : `${cityName(inn)} / ${cityName(out)}`)} · ${cls === 'hybrid' ? 'business' : 'economy'}${home !== 'YVR' ? ` · ${home}` : ''}</span><b>${money(a.total)}</b></li>`;
    }).join('') || '<li class="empty">No deals alerted yet</li>'}</ol>` : ''}

    ${status?.alerts ? `<h3>Alert when</h3>
    <section class="panel rules">
      <div><small>Business buy tier</small><b>≤ ${money(status.alerts.tiers.hybrid[0][0])}</b></div>
      <div><small>Economy buy tier</small><b>≤ ${money(status.alerts.tiers.economy[0][0])}</b></div>
      <div><small>Business long flights</small><b>&lt; ${money(status.alerts.cheapBusinessLongLegs)}</b></div>
      <div><small>New low after</small><b>${status.alerts.newLowWarmupDays} days</b></div>
      <div><small>Again after a drop of</small><b>${money(status.alerts.realertDrop.cad)} / ${status.alerts.realertDrop.share * 100}%</b></div>
      <div><small>Pushes per sweep</small><b>≤ ${status.alerts.maxPushesPerRun}</b></div>
    </section>` : ''}

    <h3>Recent sweeps</h3>
    <ol class="list runs">${(health?.runs ?? []).map((r) => `
      <li class="${r.success ? '' : 'bad'}">
        <span class="when">${when(r.at)}</span>
        <span class="what">${r.ok}/${r.ok + r.failed} · ${r.changes.toLocaleString('en-CA')} changed · ${r.egress} · ${mins(r.seconds)}</span>
        <b>${r.success ? 'OK' : 'FAIL'}</b>
        ${r.errors?.length ? `<details><summary>${r.errors.length} error${r.errors.length > 1 ? 's' : ''}</summary>${r.errors.map((e) => `<pre>${esc(e.split('\n')[0])}</pre>`).join('')}</details>` : ''}
      </li>`).join('') || '<li class="empty">No runs yet</li>'}
    </ol>

    ${d ? `<h3>Flight checks</h3>
    <section class="panel rules">
      <div><small>Cells checked</small><b>${d.cells.toLocaleString('en-CA')}</b></div>
      <div><small>Moved to another trip</small><b>${d.replaced}</b></div>
      <div><small>None connects</small><b>${d.unresolved}</b></div>
      <div><small>Searches</small><b>${d.searches} <span class="${d.failed ? 'warn' : ''}">(${d.failed} failed)</span></b></div>
      <div><small>Not listed yet</small><b>${d.none.toLocaleString('en-CA')} flights</b></div>
      <div><small>Took</small><b>${Math.round(d.ms / 1000)}s</b></div>
    </section>` : ''}

    <h3>Routes</h3>
    ${stale.length ? `<ol class="list routes">${stale.map(routeItem).join('')}</ol>` : ''}
    <details class="all-routes"><summary>${routes.length} routes${stale.length ? `, ${stale.length} stale` : ''} · newest ${ago(routes.map((r) => r.newest).filter(Boolean).sort().at(-1))}</summary>
      <ol class="list routes">${routes.slice().sort((a, b) => (a.newest ?? '').localeCompare(b.newest ?? '')).map(routeItem).join('')}</ol>
    </details>
    <p class="note">Updated ${status ? when(status.generatedAt) : '—'}</p>`;
  alertsBar(el.querySelector('#alerts'));
  sweepButton(el.querySelector('#sweep'));
}
