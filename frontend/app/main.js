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
import { sweepIfAsked } from './alerts.js';
import { renderHealth } from './health.js';
import { renderHistory } from './history.js';
import { register, showBar, clearBar } from './pwa.js';

const params = new URLSearchParams(location.search);
const ALERT_SHA = /^[0-9a-f]{40}$/.test(params.get('v') ?? '') ? params.get('v') : null;
const REPO = 'brennanwilkes/flight-price-tracker';
const DATA_OVERRIDE = params.get('data'); // local testing: a directory laid out like the data branch
const POLL_MS = 5 * 60e3;

// $ tiers per column, cheapest first: a fallback for data built before cells carried `tier`.
// The source of truth is scraper/config/alerts.json (the alerts use it too).
const TIERS = {
  hybrid: [[3500, 'buy'], [4200, 'great'], [5000, 'good']],
  economy: [[800, 'buy'], [1000, 'great'], [1300, 'good']],
};
// "Business" is the hybrid: business class to and from Asia, economy hops within it.
const COLUMNS = [['hybrid', 'Business'], ['economy', 'Economy']];

// sha: the data-branch commit the loaded files came from. The open trip lives in the URL hash
// (#trip=IN-OUT~class), so the back gesture closes it and an alert can link straight to one.
// ?home= (from an alert) picks the home airport, else the last one used.
// data: "HOME" (all trips) or "HOME-CITY" (the via filter: trips staying in CITY) → trips file.
const state = { home: /^(YVR|YYJ)$/.test(params.get('home') ?? '') ? params.get('home') : localGet('home') ?? 'YVR', month: '', via: '', sha: null, data: {} };
// Priority class, per device: sorts the board, opens first, leads History. Alerts cover both.
state.priority = localGet('priority') === 'economy' ? 'economy' : 'hybrid';
const otherClass = () => (state.priority === 'hybrid' ? 'economy' : 'hybrid');
const viewKey = () => (state.via ? `${state.home}-${state.via}` : state.home);
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
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'long', timeZone: 'UTC' });
const fmtMonth = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const tier = (cls, total) => TIERS[cls].find(([max]) => total <= max)?.[1] ?? '';
const tierOfTrip = (cls, t) => t.tier ?? tier(cls, t.total); // the builder's (config/alerts.json), else the fallback
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

/** A trips file: "YVR" → derived/trips-YVR.json, "YVR-BKK" → derived/via/trips-YVR-BKK.json. */
const dataBase = (sha) => DATA_OVERRIDE ?? `https://raw.githubusercontent.com/${REPO}/${sha}`;

async function fetchTrips(sha, key) {
  const base = dataBase(sha);
  const res = await fetch(`${base}/derived/${key.includes('-') ? 'via/' : ''}trips-${key}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`trips-${key}.json: HTTP ${res.status}`);
  return res.json();
}

/** The current view's trips, and its home's (for the via list), fetched once per data commit. */
async function load() {
  state.data[state.home] ??= await fetchTrips(state.sha, state.home);
  if (!state.data[state.home].vias?.includes(state.via)) state.via = '';
  if (state.via) state.data[viewKey()] ??= await fetchTrips(state.sha, viewKey());
}

/** Rows for the current month filter, each with its two cells, sorted by hybrid then economy. */
function rows(data) {
  const pick = (r) => (state.month ? r.months[state.month] ?? {} : r);
  const price = (t) => t?.total ?? Infinity;
  return data.rows
    .map((r) => ({ ...r, cells: pick(r) }))
    .filter((r) => r.cells.hybrid || r.cells.economy)
    .sort((a, b) => price(a.cells[state.priority]) - price(b.cells[state.priority]) || price(a.cells[otherClass()]) - price(b.cells[otherClass()]));
}

/** ▲/▼ and the change vs 24 h ago (overall cells only: the builder sets `was` there). */
function trend(trip) {
  if (trip.was == null || trip.was === trip.total) return '';
  const d = trip.total - trip.was;
  return `<span class="trend ${d < 0 ? 'down' : 'up'}" title="24 h ago: ${money(trip.was)}">${d < 0 ? '▼' : '▲'}${Math.abs(d).toLocaleString('en-CA')}</span>`;
}

/** "SEP 05–22" (or "SEP 28–OCT 12"). */
const range = (t) => (t.depart.slice(0, 7) === t.ret.slice(0, 7) ? `${boardDate(t.depart)}–${t.ret.slice(8)}` : `${boardDate(t.depart)}–${boardDate(t.ret)}`);
const alts = (t) => (t.alts ? `<i class="alts" title="${t.alts} other date${t.alts > 1 ? 's' : ''} within 2% of this price">+${t.alts}</i>` : '');

/** A fare tile: price, its dates, the change vs yesterday, and +N similar dates. */
function fare(cls, trip) {
  if (!trip) return '<span class="fare none">—</span>';
  return `<button type="button" class="fare ${tierOfTrip(cls, trip)}" data-cls="${cls}">
    <b>${money(trip.total)}</b><span class="tdates">${range(trip)}${alts(trip)}</span>${trend(trip)}
  </button>`;
}

/** "Hong Kong / Tokyo", breaking only at the slash. */
const pairName = (r) => (r.in === r.out ? `<span>${esc(cityName(r.in))}</span>` : `<span>${esc(cityName(r.in))} /</span> <span>${esc(cityName(r.out))}</span>`);

/** One board row: the destination, then a fare tile per class. */
function boardRow(r, i) {
  return `<li class="row${i === 0 ? ' headline' : ''}" data-row="${r.in}-${r.out}">
    <div class="dest">${pairName(r)}</div>
    ${COLUMNS.map(([cls]) => fare(cls, r.cells[cls])).join('')}
  </li>`;
}

/** The month and via selects, for the current view (board and history share them). */
function fillFilters(data) {
  const months = [...new Set(data.rows.flatMap((r) => Object.keys(r.months)))].sort();
  $('#month').innerHTML = `<option value="">All months</option>${months.map((m) => `<option value="${m}"${m === state.month ? ' selected' : ''}>${fmtMonth(m)}</option>`).join('')}`;
  const vias = state.data[state.home]?.vias ?? [];
  $('#via').hidden = !vias.length; // data built before the via filter has none
  $('#via').innerHTML = `<option value="">Any city</option>${vias.map((c) => `<option value="${c}"${c === state.via ? ' selected' : ''}>Via ${esc(cityName(c))}</option>`).join('')}`;
}

// Tabs by hash: #history, #health, else the board (whose trip view is #trip=…).
const tabOf = () => ({ '#history': 'history', '#health': 'health' })[location.hash] ?? 'board';

function render() {
  const tab = (state.tab = tabOf());
  document.body.dataset.tab = tab;
  for (const a of document.querySelectorAll('.tabs a')) a.toggleAttribute('aria-current', a.dataset.tab === tab);
  for (const b of document.querySelectorAll('.toggle button')) b.setAttribute('aria-pressed', String(b.dataset.home === state.home));
  if (tab === 'health') {
    renderSheet();
    renderHealth($('#view'), dataBase(state.sha), { priority: state.priority, setPriority });
    return;
  }
  if (tab === 'history') {
    renderSheet();
    const data = state.data[viewKey()];
    if (data) { fillFilters(data); renderHistory($('#view'), dataBase(state.sha), state.home, rows(data), state.priority); }
    return;
  }
  const data = state.data[viewKey()];
  if (!data) return;

  fillFilters(data);
  const list = rows(data);
  $('#view').innerHTML = list.length
    ? `<div class="board-head"><span>Destination</span><span>Business</span><span>Economy</span></div>
      <ol class="board">${list.map(boardRow).join('')}</ol>
      <p class="note">Business: business class to and from Asia, economy within it. +N: other dates within 2% of the price.</p>`
    : '<p class="note">No complete trips yet.</p>';
  $('#stamp').textContent = `Updated ${new Date(data.generatedAt).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`;

  // A fare tile opens that class's trip; anywhere else on the row opens the first one there is.
  for (const li of document.querySelectorAll('li[data-row]')) {
    li.addEventListener('click', (e) => {
      const cls = e.target.closest('[data-cls]')?.dataset.cls
        ?? (li.querySelector(`[data-cls="${state.priority}"]`) ?? li.querySelector('[data-cls]'))?.dataset.cls;
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
// Only a fallback: with flight details the real arrival is known.
const landsOn = (l) => (CITIES[l.from]?.lon == null || CITIES[l.to]?.lon == null ? addDay(l.date) : l.date);
const addDay = (iso) => new Date(Date.parse(`${iso}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);
const dur = (min) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
const minutesAt = (date, hm) => Date.parse(`${date}T${hm}:00Z`) / 60e3; // local clock; compare within one city only
/** The flights Google lists for this leg (scraper/src/trips/details.js), or undefined. */
const flightOf = (l) => l.t.flights?.[l.leg ?? 'out'];

/** Between two legs: the time in the city, from real flight times when known. */
function layover(prev, next) {
  const where = esc(cityName(prev.to));
  if (flightOf(next)?.miss === 'connection') return `<li class="layover bad"><span>Misses connection · ${where}</span></li>`;
  const { nights, wait } = stay(prev, next);
  if (nights > 0) return `<li class="layover"><span>${nights} night${nights > 1 ? 's' : ''} · ${where}</span></li>`;
  return `<li class="layover"><span>${wait != null ? `${dur(wait)} layover` : 'Same day'} · ${where}</span></li>`;
}

/** Nights in the city between two legs, and the wait in minutes when both flights' times are known. */
function stay(prev, next) {
  const a = flightOf(prev), b = flightOf(next);
  if (a?.legs && b?.legs) {
    const land = a.legs.at(-1), dep = b.legs[0];
    return {
      nights: (Date.parse(dep.depDate) - Date.parse(land.arrDate)) / 864e5,
      wait: minutesAt(dep.depDate, dep.dep) - minutesAt(land.arrDate, land.arr),
    };
  }
  // One side unknown: the real landing day if known, else the usual one.
  return { nights: (Date.parse(next.date) - Date.parse(a?.legs?.at(-1).arrDate ?? landsOn(prev))) / 864e5, wait: null };
}

/**
 * The flights inside one leg: each a box reading departure → arrival, times over airports with
 * the duration between, flight number, airline and aircraft above; connections between them
 * styled like the stays between tickets.
 */
function segments(l) {
  const f = flightOf(l);
  const cab = l.cabin === 'J' ? '<span class="cab biz">Business</span>' : '<span class="cab">Economy</span>';
  if (!f) return '';
  if (f.miss === 'none') return `<span class="segs"><span class="seg-miss">Not scheduled yet · ${cab}</span></span>`;
  if (f.miss) return '';
  const segs = f.legs.map((g, i) => {
    const plus = (Date.parse(g.arrDate) - Date.parse(g.depDate)) / 864e5;
    const conn = i ? `<span class="conn"><span>${dur(f.stops[i - 1]?.min ?? 0)} · ${esc(cityName(g.from))}</span></span>` : '';
    return `${conn}<span class="sg">
      <small class="sg-id"><span>${esc(g.code)} · ${esc(g.airline ?? '')}${g.plane ? ` · ${esc(g.plane)}` : ''}</span>${cab}</small>
      <span class="sg-end"><b>${g.dep}</b><small>${g.from}</small></span>
      <span class="sg-dur">${dur(g.min)}</span>
      <span class="sg-end arr"><b>${g.arr}${plus ? `<sup>+${plus}</sup>` : ''}</b><small>${g.to}</small></span>
    </span>`;
  }).join('');
  return `<span class="segs">${segs}</span>`;
}

/**
 * One flight: a slim line of date, route and price, its segments below; the whole card opens it in Google
 * Flights. Each ticket has its own colour on the card's left edge (--tk1…); a return ticket's
 * two flights are also joined by a rail down the left gutter (CSS).
 */
function legItem(l, ticketOf) {
  const rt = l.t.kind === 'rt';
  const price = !rt || l.leg === 'out' ? money(l.t.price) : '';
  const dow = new Date(`${l.date}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', timeZone: 'UTC' }).toUpperCase().replace('.', '');
  return `<li class="leg ${l.cabin === 'J' ? 'biz' : 'eco'}" style="--tk: var(--tk${ticketOf.get(l.t)})">
    <a href="${flightsLink(l.t)}" target="_blank" rel="noopener">
      <span class="leg-head">
        <span class="day">${dow} ${boardDate(l.date)}</span>
        <b class="route"><span>${esc(cityName(l.from))}<span class="arrow">→</span></span> <span>${esc(cityName(l.to))}</span></b>
        <b class="price">${price || '<span class="incl">incl.</span>'}</b>
      </span>
      ${segments(l)}
    </a>
  </li>`;
}

/** Nights stayed per city (overnight stays only), for the map: city → [nights, …] in order. */
function staysOf(list) {
  const out = new Map();
  for (let i = 1; i < list.length; i++) {
    const { nights } = stay(list[i - 1], list[i]);
    if (nights > 0) out.set(list[i].from, [...(out.get(list[i].from) ?? []), nights]);
  }
  return out;
}

/** Every flight actually flown, for the map: a leg's connections when known, else the leg. */
const flown = (list, ticketOf) => list.flatMap((l) => {
  const f = flightOf(l);
  const tk = ticketOf.get(l.t);
  return f?.legs ? f.legs.map((g) => ({ from: g.from, to: g.to, cabin: l.cabin, tk })) : [{ from: l.from, to: l.to, cabin: l.cabin, tk }];
});

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
  const data = state.data[viewKey()];
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
  // Tickets numbered in the order they're first flown, for their colours.
  const ticketOf = new Map();
  for (const l of list) if (!ticketOf.has(l.t)) ticketOf.set(l.t, Math.min(ticketOf.size + 1, 6));
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
      <div class="seg" role="tablist">${COLUMNS.filter(([c]) => row.cells[c]).map(([c, label]) => `
        <button type="button" role="tab" data-cls="${c}" aria-selected="${c === cls}">${label} <b>${money(row.cells[c].total)}</b></button>`).join('')}
      </div>
      <button type="button" class="close" aria-label="Close">✕</button>
    </div>
    <div class="ticket ${tierOfTrip(cls, trip)}">
      <div class="stub"><small>Total</small><b>${money(trip.total)}</b>${trend(trip)}${trip.alts ? `<span class="similar">+${trip.alts} similar dates</span>` : ''}</div>
      <div class="span">
        <div class="cal"><small>${weekday(trip.depart)}</small><b>${boardDate(trip.depart)}</b></div>
        <div class="line"><span>${trip.days} days</span><span>${trip.tickets.length} ticket${trip.tickets.length > 1 ? "s" : ""}</span></div>
        <div class="cal"><small>${weekday(trip.ret)}</small><b>${boardDate(trip.ret)}</b></div>
      </div>
    </div>
    ${tripMap(flown(list, ticketOf), state.home, [...new Set(list.flatMap((l) => [l.from, l.to]))], staysOf(list))}
    <ol class="legs${trip.tickets.some((t) => t.kind === 'rt') ? ' has-rail' : ''}">${list.map((l, i) => (i ? layover(list[i - 1], l) : '') + legItem(l, ticketOf)).join('')}</ol>
`;
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
    await load();
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
/** Change this device's priority class; the board re-sorts when next shown. */
function setPriority(p) {
  state.priority = p;
  localSet('priority', p);
}
sweepIfAsked((msg) => showBar('fresh', msg, () => clearBar('fresh')));
// Switching tabs re-renders; opening or closing a trip doesn't (popstate → renderSheet).
window.addEventListener('hashchange', () => { if (tabOf() !== state.tab) render(); });
register();
// The alert's commit and home are now in state; drop them from the URL so a later reload isn't
// pinned to them.
if (params.has('v') || params.has('home')) {
  params.delete('v');
  params.delete('home');
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
  const apply = async () => {
    state.sha = sha;
    state.data = { [state.home]: fresh };
    if (!fresh.vias?.includes(state.via)) state.via = '';
    clearBar('fresh');
    await show();
  };
  if (resumed || !shown) apply();
  else showBar('fresh', 'New prices are in. Tap to show them.', apply);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(true); });
setInterval(() => { if (document.visibilityState === 'visible') refresh(false); }, POLL_MS);
$('#month').addEventListener('change', (e) => { state.month = e.target.value; render(); });
$('#via').addEventListener('change', (e) => { state.via = e.target.value; show(); });
// An alert's prices first; then anything newer than them.
show().then(() => { if (ALERT_SHA) refresh(true); });
