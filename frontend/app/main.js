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
import { CITIES, cityName } from './cities.js';
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
const TAG = { hybrid: 'J+Y', economy: 'Y' }; // fare tile labels: business long legs + economy hops, or all economy

// sha: the data-branch commit the loaded files came from. The open trip lives in the URL hash
// (#trip=IN-OUT~class), so the back gesture closes it and an alert can link straight to one.
const state = { home: localGet('home') ?? 'YVR', month: '', sha: null, data: {} };
const $ = (sel) => document.querySelector(sel);

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

const money = (n) => `$${n.toLocaleString('en-CA')}`;
const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
// Board style: "SEP 05".
const boardDate = (iso) => `${new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', timeZone: 'UTC' }).toUpperCase().replace('.', '')} ${iso.slice(8)}`;
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
  return `<span class="trend ${d < 0 ? 'down' : 'up'}" title="24 h ago: ${money(trip.was)}">${d < 0 ? '▼' : '▲'}${Math.abs(d).toLocaleString('en-CA')}</span>`;
}

/** "SEP 05 – SEP 22" plus "+N" when other dates come within 2% (the builder's alts). */
function dates(trip) {
  const alts = trip.alts ? `<i class="alts" title="${trip.alts} other date${trip.alts > 1 ? 's' : ''} within 2% of this price">+${trip.alts}</i>` : '';
  const range = trip.depart.slice(0, 7) === trip.ret.slice(0, 7) ? `${boardDate(trip.depart)}–${trip.ret.slice(8)}` : `${boardDate(trip.depart)}–${boardDate(trip.ret)}`;
  return `${range}${alts}`;
}

function fare(cls, trip) {
  if (!trip) return '<span class="fare none">—</span>';
  return `<button type="button" class="fare ${tier(cls, trip.total)}" data-cls="${cls}">
    <span class="tag">${TAG[cls]}</span><b>${money(trip.total)}</b>${trend(trip)}
  </button>`;
}

/** One board row: destination and dates on the left, a fare tile per class on the right. */
function boardRow(r, i) {
  const [h, e] = [r.cells.hybrid, r.cells.economy];
  const same = h && e && h.depart === e.depart && h.ret === e.ret;
  // Dates beside the city: the hybrid's, and the economy's too when they differ.
  const when = [h && [h, 'hybrid'], e && !same && [e, 'economy']].filter(Boolean)
    .map(([t, cls]) => `<span class="when">${h && e && !same ? `<span class="tag">${TAG[cls]}</span>` : ''}${dates(t)}</span>`).join('');
  const code = r.in === r.out ? r.in : `${r.in}<br>${r.out}`;
  return `<li class="row${i === 0 ? ' headline' : ''}" data-row="${r.in}-${r.out}">
    <div class="dest"><span class="code">${code}</span><span class="city">${esc(pairLabel(r))}</span>${when}</div>
    ${COLUMNS.map(([cls]) => fare(cls, r.cells[cls])).join('')}
  </li>`;
}

function render() {
  const data = state.data[state.home];
  for (const b of document.querySelectorAll('.toggle button')) b.setAttribute('aria-pressed', String(b.dataset.home === state.home));
  if (!data) return;

  const months = [...new Set(data.rows.flatMap((r) => Object.keys(r.months)))].sort();
  $('#month').innerHTML = `<option value="">All months</option>${months.map((m) => `<option value="${m}"${m === state.month ? ' selected' : ''}>${fmtMonth(m)}</option>`).join('')}`;

  const list = rows(data);
  $('#view').innerHTML = list.length
    ? `<div class="board-head"><span>Destination</span><span>Hybrid</span><span>Economy</span></div>
      <ol class="board">${list.map(boardRow).join('')}</ol>
      <p class="note">J+Y: business to and from Asia, economy within it. Y: economy throughout. +N: other dates within 2% of the price.</p>`
    : '<p class="note">No complete trips yet.</p>';
  $('#stamp').textContent = `Updated ${new Date(data.generatedAt).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`;

  // A fare tile opens that class's trip; anywhere else on the row opens the first one there is.
  for (const li of document.querySelectorAll('li[data-row]')) {
    li.addEventListener('click', (e) => {
      const cls = e.target.closest('[data-cls]')?.dataset.cls ?? li.querySelector('[data-cls]')?.dataset.cls;
      if (cls) openTrip(li.dataset.row, cls);
    });
  }
  renderSheet();
}

/** Google Flights search for one ticket. */
function flightsLink(t) {
  const cabin = t.cabin === 'J' ? 'business class' : 'economy';
  const q = t.kind === 'rt'
    ? `Flights from ${t.from} to ${t.to} on ${t.date} through ${t.ret} ${cabin}`
    : `One way flights from ${t.from} to ${t.to} on ${t.date} ${cabin}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}&curr=CAD&hl=en&gl=CA`;
}

/**
 * The trip's flights in flying order, numbered as on the map: the way out, the hops by date,
 * the way home. A round trip's two flights are one ticket.
 */
function legs(trip) {
  const all = trip.tickets.flatMap((t) => (t.kind === 'rt'
    ? [{ t, leg: 'out', from: t.from, to: t.to, date: t.date }, { t, leg: 'back', from: t.to, to: t.from, date: t.ret }]
    : [{ t, from: t.from, to: t.to, date: t.date }]));
  all.sort((a, b) => (a.leg === 'back') - (b.leg === 'back') || a.date.localeCompare(b.date));
  return all.map((l, i) => ({ ...l, n: i + 1, cabin: l.t.cabin }));
}

// Long hauls land the day after they leave (Asia is a day ahead); hops land the same day.
const landsOn = (l) => (CITIES[l.from]?.lon == null || CITIES[l.to]?.lon == null ? addDay(l.date) : l.date);
const addDay = (iso) => new Date(Date.parse(`${iso}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);

/** Between two legs: the nights spent in the city, or a same-day connection. */
function layover(prev, next) {
  const nights = (Date.parse(next.date) - Date.parse(landsOn(prev))) / 864e5;
  const where = esc(cityName(prev.to));
  if (nights > 0) return `<li class="layover"><span>${nights} night${nights > 1 ? 's' : ''} · ${where}</span></li>`;
  const sameTicket = prev.t === next.t;
  return `<li class="layover tight"><span>Same day · ${where}${sameTicket ? '' : ' · ⏱ check times'}</span></li>`;
}

/**
 * One flight, as a boarding-pass row of boxed fields; the whole row opens it in Google Flights.
 * Legs on one ticket (a return) carry the same ticket letter and are joined by a rail (CSS).
 */
function legItem(l, ticketOf) {
  const tk = ticketOf.get(l.t);
  const rt = l.t.kind === 'rt';
  const price = !rt ? money(l.t.price) : l.leg === 'out' ? money(l.t.price) : '';
  const note = !rt ? 'one way' : l.leg === 'out' ? 'return' : 'return ↩';
  return `<li class="leg ${l.cabin === 'J' ? 'biz' : 'eco'}${rt ? ` rail rail-${l.leg}` : ''}">
    <a href="${flightsLink(l.t)}" target="_blank" rel="noopener">
      <span class="f n">${l.n}</span>
      <span class="f day"><small>${new Date(`${l.date}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', timeZone: 'UTC' }).toUpperCase().replace('.', '')}</small>${boardDate(l.date)}</span>
      <span class="f route"><b>${l.from}<span class="arrow">→</span>${l.to}</b><small>${esc(cityName(l.from))} → ${esc(cityName(l.to))}</small></span>
      <span class="f cabin">${l.cabin === 'J' ? 'BUS' : 'ECO'}</span>
      <span class="f price"><b>${price || '<span class="incl">incl.</span>'}</b><small>${tk} · ${note}</small></span>
    </a>
  </li>`;
}

function openTrip(key, cls) {
  history.pushState({ sheet: true }, '', `#trip=${key}~${cls}`);
  renderSheet();
}

function closeTrip() {
  if (history.state?.sheet) history.back(); // popstate re-renders
  else { history.replaceState(null, '', location.pathname + location.search); renderSheet(); }
}

/** The full-screen trip view for #trip=IN-OUT~class, or nothing. */
function renderSheet() {
  const m = /^#trip=([A-Z]{3}-[A-Z]{3})~(hybrid|economy)$/.exec(location.hash);
  const data = state.data[state.home];
  const row = m && data && rows(data).find((r) => `${r.in}-${r.out}` === m[1]);
  let sheet = $('#sheet');
  if (!row) {
    sheet?.remove();
    document.body.classList.remove('sheet-open');
    return;
  }
  const cls = row.cells[m[2]] ? m[2] : COLUMNS.find(([c]) => row.cells[c])[0];
  const trip = row.cells[cls];
  const list = legs(trip);
  // Tickets lettered in the order they're first flown: A, B, C…
  const ticketOf = new Map();
  for (const l of list) if (!ticketOf.has(l.t)) ticketOf.set(l.t, `TKT ${String.fromCharCode(65 + ticketOf.size)}`);
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'sheet';
    sheet.className = 'sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    document.body.appendChild(sheet);
    document.body.classList.add('sheet-open');
  }
  sheet.setAttribute('aria-label', pairLabel(row));
  sheet.innerHTML = `
    <div class="sheet-bar">
      <button type="button" class="close" aria-label="Close">✕</button>
      <div><h2>${esc(pairLabel(row))}</h2>
      <span>from ${esc(cityName(state.home))}${state.month ? ` · ${fmtMonth(state.month)}` : ''}</span></div>
    </div>
    <div class="seg" role="tablist">${COLUMNS.filter(([c]) => row.cells[c]).map(([c, label]) => `
      <button type="button" role="tab" data-cls="${c}" aria-selected="${c === cls}">${label} <b>${money(row.cells[c].total)}</b></button>`).join('')}
    </div>
    <div class="sum ${tier(cls, trip.total)}">
      <b>${money(trip.total)}</b>${trend(trip)}
      <span>${fmtDay(trip.depart)} – ${fmtDay(trip.ret)} · ${trip.days} days · ${trip.tickets.length} tickets${trip.alts ? ` · +${trip.alts} other dates within 2%` : ''}</span>
    </div>
    ${tripMap(list, state.home)}
    <ol class="legs${trip.tickets.some((t) => t.kind === 'rt') ? ' has-rail' : ''}">${list.map((l, i) => (i ? layover(list[i - 1], l) : '') + legItem(l, ticketOf)).join('')}</ol>
    ${trip.sameDay ? '<p class="note">⏱ Includes a same-day connection between separate tickets: check the times before booking.</p>' : ''}
    <p class="note">Prices are Google Flights' lowest for each date when last checked. Tap a flight to see it there.</p>`;
  sheet.querySelector('.close').addEventListener('click', closeTrip);
  for (const b of sheet.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      history.replaceState(history.state, '', `#trip=${m[1]}~${b.dataset.cls}`);
      renderSheet();
    });
  }
}

window.addEventListener('popstate', renderSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#sheet')) closeTrip(); });

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
$('#month').addEventListener('change', (e) => { state.month = e.target.value; render(); });
// An alert's prices first; then anything newer than them.
show().then(() => { if (ALERT_SHA) refresh(true); });
