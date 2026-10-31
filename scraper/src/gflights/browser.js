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
const SCROLL_TIMEOUT_MS = 8_000;
const OPEN_RETRY_MS = 6_000;
// Airlines load fares ~330 days out; the graph silently stops fetching there.
// Measured 2026-10-30: last loaded return date = today + 329.
const HORIZON_DAYS = 330;
const HORIZON_SLACK_DAYS = 15;
const today = () => new Date().toISOString().slice(0, 10);

// Runs in the page before Google's code: keeps a copy of every FlightsFrontendService response
// as the page itself receives it. Reading bodies through DevTools (page.on('response')) loses
// them intermittently ("No data found for resource"), badly so on 2-vCPU Actions runners.
const RECORDER = `(() => {
  const log = (window.__rpc = []);
  const want = (u) => /FlightsFrontendService\\//.test(String(u));
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__u = String(u); return open.call(this, m, u, ...rest); };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    if (want(this.__u)) this.addEventListener('loadend', () => {
      let text = null;
      try { text = this.responseText; } catch {}
      log.push({ url: this.__u, status: this.status, text });
    });
    return send.apply(this, a);
  };
  const f = window.fetch;
  window.fetch = async (...a) => {
    const res = await f(...a);
    const u = a[0] instanceof Request ? a[0].url : a[0];
    if (want(u)) res.clone().text().then((text) => log.push({ url: String(u), status: res.status, text }), () => log.push({ url: String(u), status: res.status, text: null }));
    return res;
  };
})();`;

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

/**
 * Round-trip prices for every departure day in [start, end] at one trip length.
 * One page load; the first GetCalendarGraph covers 60 days (from start - 7), each "Scroll
 * forward" 21 more. The graph stops at the fare-loading horizon (~330 days out): there the
 * forward button is disabled, so a short result near the horizon is "not loaded yet", not an error.
 */
async function priceGraph(ctx, { from, to, cabin, tripLen, start, end }) {
  if (addDays(start, tripLen) > addDays(today(), HORIZON_DAYS)) return []; // nothing loaded yet
  const page = await ctx.newPage();
  try {
    await page.goto(pageUrl({ from, to, out: start, ret: addDays(start, tripLen), cabin }), { waitUntil: 'networkidle' });
    const graphBtn = page.getByRole('button', { name: 'Price graph' }).first();
    await graphBtn.waitFor({ timeout: RPC_TIMEOUT_MS });
    const cells = new Map();
    const add = (list) => { for (const c of list) if (c.out >= start && c.out <= end) cells.set(c.out, c); };
    // A click that lands before the page has hydrated does nothing; click again rather than wait.
    let opened;
    try {
      opened = await capture(page, 'GetCalendarGraph', parseCalendar, () => graphBtn.click(), 'open graph', OPEN_RETRY_MS);
    } catch {
      await page.keyboard.press('Escape').catch(() => {});
      opened = await capture(page, 'GetCalendarGraph', parseCalendar, () => graphBtn.click(), 'open graph (2nd click)');
    }
    add(opened);
    const fwd = page.getByRole('button', { name: 'Scroll forward' });
    // The forward button looks the same at the horizon; it just stops fetching.
    const horizon = addDays(today(), HORIZON_DAYS - HORIZON_SLACK_DAYS);
    let last = [...cells.keys()].at(-1) ?? start;
    for (let i = 0; i < 12 && last < end; i++) {
      if (addDays(last, tripLen) >= addDays(today(), HORIZON_DAYS - 2)) break; // at the horizon already
      try {
        add(await capture(page, 'GetCalendarGraph', parseCalendar, () => fwd.click(), `scroll ${i + 1}`, SCROLL_TIMEOUT_MS));
      } catch (e) {
        if (addDays(last, tripLen) >= horizon) break;
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
  const page = await ctx.newPage();
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

module.exports = { openBrowser, priceGraph, bookingOptions, addDays };
