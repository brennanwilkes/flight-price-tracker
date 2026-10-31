// Main page: one row per in/out city pair, Hybrid and Full economy columns; tap a row for the
// trip details. Reads derived/trips-<HOME>.json from the data branch (scraper/bin/build-trips.js).
//
// FRESHNESS: prices on screen are never older than the server's, and never go backwards.
// - Files are read at a data-branch commit, not the branch: raw.githubusercontent.com caches a
//   branch URL for 5 min, a commit URL is immutable.
// - An alert's link carries ?v=<commit> of the sweep that raised it, so opening it shows those
//   prices (the API answering "which commit is current" is itself cached up to 60 s).
// - The current commit is checked on resume and every 5 min while visible. Newer data applies at
//   once on resume; mid-use it's a tap-to-show bar, so prices don't change under a tap. Data
//   whose generatedAt isn't newer than what's shown (a stale API answer) is ignored.
import { cityName } from './cities.js';
import { tripMap } from './map.js';
import { alertsBar, sweepButton } from './alerts.js';
import { register, showBar, clearBar } from './pwa.js';

const params = new URLSearchParams(location.search);
const ALERT_SHA = /^[0-9a-f]{40}$/.test(params.get('v') ?? '') ? params.get('v') : null;
const REPO = 'brennanwilkes/flight-price-tracker';
const DATA_OVERRIDE = params.get('data'); // local testing: a directory laid out like the data branch
const POLL_MS = 5 * 60e3;

// $ tiers per column, cheapest first. Placeholders: tune once there's a few weeks of data.
const TIERS = {
  hybrid: [[3500, 'buy'], [4200, 'great'], [5000, 'good']],
  economy: [[800, 'buy'], [1000, 'great'], [1300, 'good']],
};
const COLUMNS = [['hybrid', 'Hybrid'], ['economy', 'Full economy']];

// sha: the data-branch commit the loaded files came from. open: the expanded row, as 'IN-OUT'.
const state = { home: localGet('home') ?? 'YVR', month: '', sha: null, data: {}, open: null };
const $ = (sel) => document.querySelector(sel);

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

const money = (n) => `$${n.toLocaleString('en-CA')}`;
const fmtDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
// "Sep 22–Oct 13", or "Sep 3–17" within a month.
const dateRange = (a, b) => (a.slice(0, 7) === b.slice(0, 7) ? `${fmtDate(a)}–${Number(b.slice(8))}` : `${fmtDate(a)}–${fmtDate(b)}`);
const fmtMonth = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const tier = (cls, total) => TIERS[cls].find(([max]) => total <= max)?.[1] ?? '';
const pairLabel = (r) => (r.in === r.out ? cityName(r.in) : `${cityName(r.in)} → ${cityName(r.out)}`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The data branch's current commit. Files are then read at that commit: raw.githubusercontent.com
 * caches a branch URL for 5 min, but a commit URL never changes. On failure (e.g. the API's
 * 60/h limit; 304s don't count) fall back to the branch name.
 */
async function dataSha() {
  if (DATA_OVERRIDE) return 'local';
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/data`, { cache: 'no-cache', headers: { Accept: 'application/vnd.github.sha' } });
    if (res.ok) return (await res.text()).trim();
  } catch {}
  return 'data';
}

async function fetchTrips(sha, home) {
  const base = DATA_OVERRIDE ?? `https://raw.githubusercontent.com/${REPO}/${sha}`;
  const res = await fetch(`${base}/derived/trips-${home}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`trips-${home}.json: HTTP ${res.status}`);
  return res.json();
}

async function load(home) {
  return (state.data[home] ??= await fetchTrips(state.sha, home));
}

/** Rows for the current month filter, each with its two cells, sorted by hybrid then economy. */
function rows(data) {
  const pick = (r) => (state.month ? r.months[state.month] ?? {} : r);
  const price = (t) => t?.total ?? Infinity;
  return data.rows
    .map((r) => ({ ...r, cells: pick(r) }))
    .filter((r) => r.cells.hybrid || r.cells.economy)
    .sort((a, b) => price(a.cells.hybrid) - price(b.cells.hybrid) || price(a.cells.economy) - price(b.cells.economy));
}

/** ▲/▼ and the change vs 24 h ago (overall cells only: the builder sets `was` there). */
function trend(trip) {
  if (trip.was == null || trip.was === trip.total) return '';
  const d = trip.total - trip.was;
  return ` <span class="trend ${d < 0 ? 'down' : 'up'}" title="24 h ago: ${money(trip.was)}">${d < 0 ? '▼' : '▲'}${money(Math.abs(d))}</span>`;
}

function cell(cls, trip) {
  if (!trip) return '<td class="price none">–</td>';
  return `<td class="price ${tier(cls, trip.total)}">
    <b>${money(trip.total)}${trend(trip)}</b>
    <small>${dateRange(trip.depart, trip.ret)}${trip.sameDay ? ' ⏱' : ''}</small>
  </td>`;
}

function render() {
  const data = state.data[state.home];
  for (const b of document.querySelectorAll('.toggle button')) b.setAttribute('aria-pressed', String(b.dataset.home === state.home));
  if (!data) return;

  const months = [...new Set(data.rows.flatMap((r) => Object.keys(r.months)))].sort();
  $('#month').innerHTML = `<option value="">All months</option>${months.map((m) => `<option value="${m}"${m === state.month ? ' selected' : ''}>${fmtMonth(m)}</option>`).join('')}`;

  const list = rows(data);
  const body = (r, i) => {
    const key = `${r.in}-${r.out}`;
    return `<tr data-row="${key}" class="${i === 0 ? 'headline' : ''}${state.open === key ? ' open' : ''}">
      <th scope="row">${esc(pairLabel(r))}</th>${COLUMNS.map(([cls]) => cell(cls, r.cells[cls])).join('')}
    </tr>${state.open === key ? `<tr class="details"><td colspan="3">${details(r)}</td></tr>` : ''}`;
  };
  $('#view').innerHTML = list.length
    ? `<table>
        <thead><tr><th></th>${COLUMNS.map(([, label]) => `<th>${label}</th>`).join('')}</tr></thead>
        <tbody>${list.map(body).join('')}</tbody>
      </table>
      <p class="note">⏱ = same-day connection between separate tickets; times still to verify.</p>`
    : '<p class="note">No complete trips yet.</p>';
  $('#stamp').textContent = `Updated ${new Date(data.generatedAt).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`;

  for (const tr of document.querySelectorAll('tr[data-row]')) {
    tr.addEventListener('click', () => {
      const key = tr.dataset.row;
      state.open = state.open === key ? null : key;
      render();
    });
  }
}

/** Google Flights search for one ticket. */
function flightsLink(t) {
  const cabin = t.cabin === 'J' ? 'business class' : 'economy';
  const q = t.kind === 'rt'
    ? `Flights from ${t.from} to ${t.to} on ${t.date} through ${t.ret} ${cabin}`
    : `One way flights from ${t.from} to ${t.to} on ${t.date} ${cabin}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}&curr=CAD&hl=en&gl=CA`;
}

function ticketRows(trip) {
  // A round trip's way home goes last, after the hops.
  const legs = trip.tickets.flatMap((t) => (t.kind === 'rt'
    ? [{ ...t, leg: 'out' }, { ...t, leg: 'back', from: t.to, to: t.from, date: t.ret }]
    : [t]));
  legs.sort((a, b) => (a.leg === 'back') - (b.leg === 'back') || a.date.localeCompare(b.date));
  return legs.map((t) => {
    const price = t.kind === 'rt' ? (t.leg === 'out' ? `${money(t.price)} round trip` : 'same ticket') : money(t.price);
    return `<li><details>
      <summary><span>${fmtDate(t.date)}</span> ${esc(cityName(t.from))} → ${esc(cityName(t.to))} <em>${t.cabin === 'J' ? 'Business' : 'Economy'}</em> <b>${price}</b></summary>
      <p>${t.from} → ${t.to}, ${t.date}${t.kind === 'rt' ? `, back ${t.ret}` : ''}. <a href="${flightsLink(t)}" target="_blank" rel="noopener">Google Flights ↗</a></p>
    </details></li>`;
  }).join('');
}

function details(r) {
  return COLUMNS.filter(([cls]) => r.cells[cls]).map(([cls, label]) => {
    const trip = r.cells[cls];
    return `<section class="trip">
      <h3>${label} · ${money(trip.total)} · ${trip.days} days</h3>
      ${tripMap(trip, state.home)}
      <ol>${ticketRows(trip)}</ol>
    </section>`;
  }).join('');
}

async function show() {
  try {
    state.sha ??= ALERT_SHA ?? await dataSha();
    await load(state.home);
  } catch (e) {
    $('#view').innerHTML = `<p class="note">Couldn't load trips: ${esc(e.message)}</p>`;
    return;
  }
  render();
}

for (const b of document.querySelectorAll('.toggle button')) {
  b.addEventListener('click', () => {
    state.home = b.dataset.home;
    state.open = null;
    localSet('home', state.home);
    show();
  });
}
alertsBar($('#alerts'));
sweepButton($('#sweep'));
register();
// The alert's commit is now in state; drop it from the URL so a later reload isn't pinned to it.
if (params.has('v')) {
  params.delete('v');
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
}

/** Newer data on the data branch → apply it (resume) or offer it (mid-use). Keeps the open row and month. */
async function refresh(resumed) {
  const sha = await dataSha();
  if (sha === state.sha || sha === 'data' || sha === 'local') return;
  let fresh;
  try { fresh = await fetchTrips(sha, state.home); } catch { return; }
  const shown = state.data[state.home];
  if (shown && Date.parse(fresh.generatedAt) <= Date.parse(shown.generatedAt)) return;
  const apply = () => {
    state.sha = sha;
    state.data = { [state.home]: fresh };
    clearBar('fresh');
    render();
  };
  if (resumed || !shown) apply();
  else showBar('fresh', 'New prices are in. Tap to show them.', apply);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(true); });
setInterval(() => { if (document.visibilityState === 'visible') refresh(false); }, POLL_MS);
$('#month').addEventListener('change', (e) => { state.month = e.target.value; state.open = null; render(); });
// An alert's prices first; then anything newer than them.
show().then(() => { if (ALERT_SHA) refresh(true); });
