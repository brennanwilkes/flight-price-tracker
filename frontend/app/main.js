// Main page: one row per in/out city pair, Hybrid and Full economy columns; tap a row for the
// trip details. Reads derived/trips-<HOME>.json from the data branch (scraper/bin/build-trips.js).
import { cityName } from './cities.js';
import { tripMap } from './map.js';

const params = new URLSearchParams(location.search);
const DATA = params.get('data') ?? 'https://raw.githubusercontent.com/brennanwilkes/flight-price-tracker/data';

// $ tiers per column, cheapest first. Placeholders: tune once there's a few weeks of data.
const TIERS = {
  hybrid: [[3500, 'buy'], [4200, 'great'], [5000, 'good']],
  economy: [[800, 'buy'], [1000, 'great'], [1300, 'good']],
};
const COLUMNS = [['hybrid', 'Hybrid'], ['economy', 'Full economy']];

const state = { home: localGet('home') ?? 'YVR', month: '', data: {}, open: null };
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

async function load(home) {
  if (state.data[home]) return state.data[home];
  const res = await fetch(`${DATA}/derived/trips-${home}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`trips-${home}.json: HTTP ${res.status}`);
  return (state.data[home] = await res.json());
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
  const body = (r, i) => `<tr data-row="${i}" class="${i === 0 ? 'headline' : ''}${state.open === i ? ' open' : ''}">
      <th scope="row">${esc(pairLabel(r))}</th>${COLUMNS.map(([cls]) => cell(cls, r.cells[cls])).join('')}
    </tr>${state.open === i ? `<tr class="details"><td colspan="3">${details(r)}</td></tr>` : ''}`;
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
      const i = Number(tr.dataset.row);
      state.open = state.open === i ? null : i;
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
$('#month').addEventListener('change', (e) => { state.month = e.target.value; state.open = null; render(); });
show();
