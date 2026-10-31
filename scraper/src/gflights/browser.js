'use strict';
/* Real-browser access to the gated FlightsFrontendService RPCs.
 *
 * The page's own JS signs each RPC (`x-goog-batchexecute-bgr`), so instead of calling them we
 * drive the UI that calls them and read the responses off the wire. The price graph is the
 * workhorse: one GetCalendarGraph call = 60 consecutive departure days at a fixed trip length.
 */
const { chromium } = require('playwright');
const { pageUrl, HEADERS } = require('./page');
const { parseBatchExecute, parseCalendar, parseBooking } = require('./batchexecute');

const RPC_TIMEOUT_MS = 20_000;
// Per load. A results page that hasn't shown the Price graph button by then has usually stalled
// for good (seen on YYJ in CI), so load it again rather than keep waiting.
const PAGE_TIMEOUT_MS = 20_000;
const PAGE_LOADS = 3;
// Google computes uncached graphs on demand: YYJ ones take 2-22s+ where YVR's come back in 0.1s.
// So wait long for a reply once the request is out, but re-click quickly if none went out.
const GRAPH_TIMEOUT_MS = 60_000;
const SENT_TIMEOUT_MS = 6_000;
// A frozen tab can hang page.evaluate forever (seen: a sweep stuck 47 min). Each page gets a hard
// deadline; closing it fails whatever is pending.
const PAGE_DEADLINE_MS = 4 * 60_000;
// Airlines load fares ~330 days out; the graph silently stops fetching there.
// Measured 2026-10-30: last loaded return date = today + 329.
const HORIZON_DAYS = 330;
const today = () => new Date().toISOString().slice(0, 10);
class NothingSent extends Error {}

// Runs in the page before Google's code: keeps a copy of every FlightsFrontendService response
// as the page itself receives it. Reading bodies through DevTools (page.on('response')) loses
// them intermittently ("No data found for resource"), badly so on 2-vCPU Actions runners.
// window.__sent logs each request as it goes out, so a slow reply isn't mistaken for a dead click.
const RECORDER = `(() => {
  const log = (window.__rpc = []);
  const sent = (window.__sent = []);
  const want = (u) => /FlightsFrontendService\\//.test(String(u));
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__u = String(u); return open.call(this, m, u, ...rest); };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    if (want(this.__u)) sent.push(this.__u);
    if (want(this.__u)) this.addEventListener('loadend', () => {
      let text = null;
      try { text = this.responseText; } catch {}
      log.push({ url: this.__u, status: this.status, text });
    });
    return send.apply(this, a);
  };
  const f = window.fetch;
  window.fetch = async (...a) => {
    const u = a[0] instanceof Request ? a[0].url : a[0];
    if (want(u)) sent.push(String(u));
    const res = await f(...a);
    if (want(u)) res.clone().text().then((text) => log.push({ url: String(u), status: res.status, text }), () => log.push({ url: String(u), status: res.status, text: null }));
    return res;
  };
})();`;

async function newPage(ctx, ms = PAGE_DEADLINE_MS) {
  const page = await ctx.newPage();
  const timer = setTimeout(() => page.close().catch(() => {}), ms);
  page.once('close', () => clearTimeout(timer));
  return page;
}

async function openBrowser({ channel = process.env.PW_CHANNEL || undefined } = {}) {
  const browser = await chromium.launch({ channel, headless: true });
  const ctx = await browser.newContext({ locale: 'en-CA', timezoneId: 'America/Vancouver', viewport: { width: 1280, height: 900 } });
  const socs = /SOCS=([^;]+)/.exec(HEADERS.cookie)[1];
  await ctx.addCookies([{ name: 'SOCS', value: socs, domain: '.google.com', path: '/' }]);
  await ctx.addInitScript(RECORDER);
  return { browser, ctx };
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * Run `action` and return `decode`d payloads of the first usable `rpc` response after it.
 * A rejected reply (HTTP 200, null wrb.fr payload) is skipped: the page retries those itself.
 */
async function capture(page, rpc, decode, action, step, timeout = RPC_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let seen = await page.evaluate(() => window.__rpc.length);
  let rejected = 0;
  let unreadable = 0;
  await action();
  for (;;) {
    const fresh = await page.evaluate((i) => window.__rpc.slice(i), seen);
    seen += fresh.length;
    for (const r of fresh) {
      if (!r.url.includes(`FlightsFrontendService/${rpc}`)) continue;
      if (r.text == null) { unreadable++; continue; }
      const payloads = parseBatchExecute(r.text).filter((p) => p != null);
      if (payloads.length) return payloads.flatMap(decode);
      rejected++;
    }
    if (Date.now() >= deadline) throw new Error(`${step}: no usable ${rpc} response within ${timeout}ms (${rejected} rejected, ${unreadable} unreadable)`);
    await page.waitForTimeout(200);
  }
}

/** Click `button`; true once a `rpc` request has gone out, false if none within SENT_TIMEOUT_MS. */
async function clickAndSend(page, button, rpc) {
  const before = await page.evaluate(() => window.__sent.length);
  await button.click();
  const deadline = Date.now() + SENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await page.evaluate(([i, r]) => window.__sent.slice(i).some((u) => u.includes(r)), [before, rpc])) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

/**
 * Prices for every departure day in [start, end]: round trip at one trip length, or one-way
 * when tripLen is null.
 * One page load; the first GetCalendarGraph covers 60 days (from start - 7), each "Scroll
 * forward" 21 more. Where the graph ends (the fare-loading horizon, ~330 days out, or sooner
 * on some one-ways) the forward button looks the same but sends nothing: that's the end of
 * the data, not an error.
 */
async function priceGraph(ctx, { from, to, cabin, tripLen = null, start, end }) {
  const span = tripLen ?? 0; // one-way when tripLen is null
  if (addDays(start, span) > addDays(today(), HORIZON_DAYS)) return []; // nothing loaded yet
  const page = await newPage(ctx);
  try {
    const url = pageUrl({ from, to, out: start, ret: tripLen == null ? null : addDays(start, tripLen), cabin });
    const graphBtn = page.getByRole('button', { name: 'Price graph' }).first();
    for (let n = 1; ; n++) {
      await page.goto(url, { waitUntil: 'networkidle' });
      try {
        await graphBtn.waitFor({ timeout: PAGE_TIMEOUT_MS });
        break;
      } catch (e) {
        if (n < PAGE_LOADS) continue;
        // What the stalled page shows, for the log.
        const text = await page.innerText('body').catch(() => '');
        throw new Error(`no Price graph button after ${PAGE_LOADS} loads; page says: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
    }
    const cells = new Map();
    const add = (list) => { for (const c of list) if (c.out >= start && c.out <= end) cells.set(c.out, c); };
    // A click that lands before the page has hydrated does nothing; click again rather than wait.
    add(await capture(page, 'GetCalendarGraph', parseCalendar, async () => {
      if (await clickAndSend(page, graphBtn, 'GetCalendarGraph')) return;
      await page.keyboard.press('Escape').catch(() => {});
      if (!(await clickAndSend(page, graphBtn, 'GetCalendarGraph'))) throw new Error('open graph: two clicks sent no request');
    }, 'open graph', GRAPH_TIMEOUT_MS));
    const fwd = page.getByRole('button', { name: 'Scroll forward' });
    let last = [...cells.keys()].at(-1) ?? start;
    for (let i = 0; i < 12 && last < end; i++) {
      if (addDays(last, span) >= addDays(today(), HORIZON_DAYS - 2)) break; // at the horizon already
      try {
        add(await capture(page, 'GetCalendarGraph', parseCalendar, async () => {
          if (!(await clickAndSend(page, fwd, 'GetCalendarGraph'))) throw new NothingSent();
        }, `scroll ${i + 1}`, GRAPH_TIMEOUT_MS));
      } catch (e) {
        if (e instanceof NothingSent) break; // end of the graph
        throw e;
      }
      last = [...cells.keys()].sort().at(-1);
    }
    return [...cells.values()].sort((a, b) => a.out.localeCompare(b.out));
  } finally {
    await page.close();
  }
}

/** Click the cheapest result row on the current results list. */
async function clickCheapest(page) {
  const rows = page.locator('ul[role=list] li').filter({ hasText: /CA\$[\d,]+/ });
  await rows.first().waitFor({ timeout: RPC_TIMEOUT_MS });
  let best = null;
  for (const [i, text] of (await rows.allInnerTexts()).entries()) {
    const price = Number(/CA\$([\d,]+)/.exec(text)?.[1].replace(/,/g, ''));
    if (price && (!best || price < best.price)) best = { i, price };
  }
  await rows.nth(best.i).click();
  return best.price;
}

/**
 * Confirm pass: seller list for the cheapest itinerary on one round-trip date pair.
 * Returns { listed, options } where listed is the results-page price and options come from
 * GetBookingResults (see parseBooking: airlineDirect, matchesCabin, fare, price).
 */
async function bookingOptions(ctx, { from, to, out, ret, cabin }) {
  const page = await newPage(ctx);
  try {
    await page.goto(pageUrl({ from, to, out, ret, cabin }), { waitUntil: 'networkidle' });
    const listed = await clickCheapest(page);
    const options = await capture(page, 'GetBookingResults', parseBooking, async () => {
      await page.waitForLoadState('networkidle');
      await clickCheapest(page);
    }, 'booking', 45_000);
    return { listed, options };
  } finally {
    await page.close();
  }
}

/**
 * A search's results as the page loads them (GetShoppingResults), for searches whose page
 * inlines none (gflights/flights.js). Returns the payload, laid out like the inline ds:1 blob.
 */
async function shoppingResults(ctx, query, { timeout = 30_000 } = {}) {
  const page = await newPage(ctx, timeout + 60_000);
  const label = `${query.from}-${query.to} ${query.out}`;
  try {
    const payloads = await capture(page, 'GetShoppingResults', (p) => [p],
      () => page.goto(pageUrl(query), { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS }), label, timeout);
    // The first reply is only Google's "top flights"; the rest (often the cheapest) load behind
    // "View more flights".
    const more = page.getByRole('button', { name: /more flights/i }).first();
    if (await more.isVisible({ timeout: 3000 }).catch(() => false)) {
      payloads.push(...await capture(page, 'GetShoppingResults', (p) => [p], () => more.click(), `${label} more`, 15_000).catch(() => []));
    }
    return payloads;
  } finally {
    await page.close();
  }
}

module.exports = { openBrowser, priceGraph, bookingOptions, shoppingResults, addDays };
