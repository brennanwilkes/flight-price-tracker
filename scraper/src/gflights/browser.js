'use strict';
/* Real-browser access to the gated FlightsFrontendService RPCs.
 *
 * The page's own JS signs each RPC (`x-goog-batchexecute-bgr`), so instead of calling them we
 * drive the UI that calls them and read the responses off the wire. The price graph is the
 * workhorse: one GetCalendarGraph call = 60 consecutive departure days at a fixed trip length.
 */
const { chromium } = require('playwright');
const { pageUrl, HEADERS } = require('./page');
const { parseBatchExecute, parseCalendar } = require('./batchexecute');

const RPC_TIMEOUT_MS = 20_000;
const SCROLL_TIMEOUT_MS = 8_000;
// Airlines load fares ~330 days out; the graph silently stops fetching there.
const HORIZON_DAYS = 330;
const HORIZON_SLACK_DAYS = 15;

async function openBrowser({ channel = process.env.PW_CHANNEL || undefined } = {}) {
  const browser = await chromium.launch({ channel, headless: true });
  const ctx = await browser.newContext({ locale: 'en-CA', timezoneId: 'America/Vancouver', viewport: { width: 1280, height: 900 } });
  const socs = /SOCS=([^;]+)/.exec(HEADERS.cookie)[1];
  await ctx.addCookies([{ name: 'SOCS', value: socs, domain: '.google.com', path: '/' }]);
  return { browser, ctx };
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** Run `action` and return the parsed calendar cells of the RPC it triggers. */
async function capture(page, rpc, action, step, timeout = RPC_TIMEOUT_MS) {
  const resP = page.waitForResponse((r) => r.url().includes(`FlightsFrontendService/${rpc}`), { timeout });
  await action();
  const res = await resP.catch((e) => { throw new Error(`${step}: no ${rpc} response (${e.message.split('\n')[0]})`); });
  const payloads = parseBatchExecute(await res.text());
  if (!payloads.length || payloads.every((p) => p == null)) throw new Error(`${rpc}: empty/rejected payload (HTTP ${res.status()})`);
  return payloads.flatMap(parseCalendar);
}

/**
 * Round-trip prices for every departure day in [start, end] at one trip length.
 * One page load; the first GetCalendarGraph covers 60 days (from start - 7), each "Scroll
 * forward" 21 more. The graph stops at the fare-loading horizon (~330 days out): there the
 * forward button is disabled, so a short result near the horizon is "not loaded yet", not an error.
 */
async function priceGraph(ctx, { from, to, cabin, tripLen, start, end }) {
  const page = await ctx.newPage();
  try {
    await page.goto(pageUrl({ from, to, out: start, ret: addDays(start, tripLen), cabin }), { waitUntil: 'networkidle' });
    const graphBtn = page.getByRole('button', { name: 'Price graph' }).first();
    await graphBtn.waitFor({ timeout: RPC_TIMEOUT_MS });
    const cells = new Map();
    const add = (list) => { for (const c of list) if (c.out >= start && c.out <= end) cells.set(c.out, c); };
    add(await capture(page, 'GetCalendarGraph', () => graphBtn.click(), 'open graph'));
    const fwd = page.getByRole('button', { name: 'Scroll forward' });
    // The forward button looks the same at the horizon; it just stops fetching.
    const horizon = addDays(new Date().toISOString().slice(0, 10), HORIZON_DAYS - HORIZON_SLACK_DAYS);
    let last = [...cells.keys()].at(-1) ?? start;
    for (let i = 0; i < 12 && last < end; i++) {
      try {
        add(await capture(page, 'GetCalendarGraph', () => fwd.click(), `scroll ${i + 1}`, SCROLL_TIMEOUT_MS));
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

module.exports = { openBrowser, priceGraph, addDays };
