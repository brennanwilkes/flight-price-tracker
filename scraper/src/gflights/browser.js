'use strict';
/* Real-browser access to the gated FlightsFrontendService RPCs.
 *
 * The page's own JS signs each RPC (`x-goog-batchexecute-bgr`), so instead of calling them we
 * drive the UI that calls them and read the responses off the wire. The price graph is the
 * workhorse: one GetCalendarGraph call = 60 consecutive departure days at a fixed trip length.
 */
const { chromium } = require('playwright');
const { pageUrl, HEADERS } = require('./page');
const { profile } = require('./page-stats');
const { parseBatchExecute, parseCalendar, parseBooking } = require('./batchexecute');

const RPC_TIMEOUT_MS = 20_000;
// Per load. A results page that hasn't shown the Price graph button by then has usually stalled
// for good (seen on YYJ in CI), so load it again rather than keep waiting.
const PAGE_TIMEOUT_MS = 20_000;
const PAGE_LOADS = 3;
// Flight lists (shoppingResults): loads per search, the wait for each but the last, and how long a
// rejected reply gets for the page to ask again itself.
const SHOP_LOADS = 2;
const SHOP_TRY_MS = 25_000;
const REJECT_GRACE_MS = 4_000;
// "View more flights": page loads at most to get its reply, and how long after a rejected reply to
// wait for the page's own retry. 5, not 3: at 0.35 pages a second (12:05 am Vancouver Nov 14) a
// reload's click got its reply about 1 time in 2 (170 of 346) and 89 pages lost the full list
// after 3 loads; a reload is ~3 s (Google has the search cached).
const MORE_TRIES = 5;
const MORE_REJECT_MS = 2_000;
// Per process: "View more flights" replies (ok on the first load, ok after a reload, rejected, no
// reply in 15 s), reloads made for it, and pages left with the top flights only after reloads.
const moreTally = { ok: 0, okReload: 0, rejected: 0, failed: 0, reloads: 0, lost: 0 };
// Google computes uncached graphs on demand: YYJ ones take 2-22s+ where YVR's come back in 0.1s.
// So wait long for a reply once the request is out, but re-click quickly if none went out.
const GRAPH_TIMEOUT_MS = 60_000;
// A rejected graph reply is never asked again by the page: 179 of 179 graph timeouts in six sweeps
// (2026-11-10) had exactly 1 rejected reply and sat out the full 60 s, ~1/5 of the slots' time.
const GRAPH_REJECT_GRACE_MS = REJECT_GRACE_MS;
const SENT_TIMEOUT_MS = 6_000;
// A frozen tab can hang page.evaluate forever (seen: a sweep stuck 47 min). Each page gets a hard
// deadline; closing it fails whatever is pending.
const PAGE_DEADLINE_MS = 4 * 60_000;
// Airlines load fares ~330 days out; the graph silently stops fetching there.
// Measured 2026-10-30: last loaded return date = today + 329.
const HORIZON_DAYS = 330;
const today = () => new Date().toISOString().slice(0, 10);
class NothingSent extends Error {}
class Rejected extends Error {}

// Runs in the page before Google's code: keeps a copy of every FlightsFrontendService response
// as the page itself receives it. Reading bodies through DevTools (page.on('response')) loses
// them intermittently ("No data found for resource"), badly so on 2-vCPU Actions runners.
// window.__sent logs each request as it goes out, so a slow reply isn't mistaken for a dead click.
const RECORDER = `(() => {
  const log = (window.__rpc = []);
  const sent = (window.__sent = []);
  const want = (u) => /FlightsFrontendService\\//.test(String(u));
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__u = String(u); this.__bgr = false; return open.call(this, m, u, ...rest); };
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (/^x-goog-batchexecute-bgr$/i.test(k) && v) this.__bgr = true; return setHeader.call(this, k, v); };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    if (want(this.__u)) sent.push(this.__u);
    if (want(this.__u)) this.addEventListener('loadend', () => {
      let text = null;
      try { text = this.responseText; } catch {}
      log.push({ url: this.__u, status: this.status, text, bgr: this.__bgr });
    });
    return send.apply(this, a);
  };
  const f = window.fetch;
  window.fetch = async (...a) => {
    const u = a[0] instanceof Request ? a[0].url : a[0];
    if (want(u)) sent.push(String(u));
    let bgr = false;
    try { bgr = !!new Headers(a[0] instanceof Request ? a[0].headers : a[1]?.headers).get('x-goog-batchexecute-bgr'); } catch {}
    const res = await f(...a);
    if (want(u)) res.clone().text().then((text) => log.push({ url: String(u), status: res.status, text, bgr }), () => log.push({ url: String(u), status: res.status, text: null, bgr }));
    return res;
  };
})();`;

async function newPage(ctx, ms = PAGE_DEADLINE_MS) {
  const page = await ctx.newPage();
  const timer = setTimeout(() => page.close().catch(() => {}), ms);
  page.once('close', () => clearTimeout(timer));
  return page;
}

// lean: images, fonts and media not loaded (the flight checks read the RPC replies, not the page's looks),
// and reduced motion (a person's setting too): a search page took ~7 CPU-seconds, 5 at once with
// their loading animations painting through 15-20 s waits (CPU by runner, 11:05 pm Vancouver, Nov 13:
// search 160-210% at 0.28 pages a second, booking ~120% at 0.57).
// flagged: the browser says it's automated (navigator.webdriver, "HeadlessChrome"). Google then
// lists fewer sellers and drops the cheapest agency fares: same IP and booking page 2026-11-11,
// flagged $4,612 (5 sellers), unflagged Trip.com $2,785 (11 sellers), as a person's Chrome sees it.
async function openBrowser({ channel = process.env.PW_CHANNEL || undefined, lean = false, flagged = process.env.BROWSER_FLAGGED === '1' } = {}) {
  const browser = await chromium.launch({ channel, headless: true, args: flagged ? [] : ['--disable-blink-features=AutomationControlled'] });
  return { browser, ctx: await newContext(browser, { lean, flagged }) };
}

/** A context (its own cookies: a new session to Google) on an open browser, as openBrowser's. */
async function newContext(browser, { lean = false, flagged = process.env.BROWSER_FLAGGED === '1' } = {}) {
  const major = browser.version().split('.')[0];
  const ctx = await browser.newContext({
    locale: 'en-CA', timezoneId: 'America/Vancouver', viewport: { width: 1280, height: 900 },
    ...(lean ? { reducedMotion: 'reduce' } : {}),
    userAgent: flagged ? undefined : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  });
  if (lean) await ctx.route('**/*', (r) => (['image', 'font', 'media'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  const socs = /SOCS=([^;]+)/.exec(HEADERS.cookie)[1];
  await ctx.addCookies([{ name: 'SOCS', value: socs, domain: '.google.com', path: '/' }]);
  await ctx.addInitScript(RECORDER);
  return ctx;
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * Run `action` and return `decode`d payloads of the first usable `rpc` response after it.
 * A rejected reply (HTTP 200, null wrb.fr payload) is skipped: the page retries those itself, given
 * up on `rejectGrace` ms after one. `load`: the action loads the page, its log starting anew.
 */
// Per process: RPC replies by outcome and whether the request carried the bgr header.
const bgrTally = { ok: { bgr: 0, none: 0 }, rejected: { bgr: 0, none: 0 } };

async function capture(page, rpc, decode, action, step, timeout = RPC_TIMEOUT_MS, rejectGrace = Infinity, load = false) {
  const deadline = Date.now() + timeout;
  let seen = await page.evaluate(() => window.__rpc.length);
  let rejected = 0;
  let rejectedBgr = 0; // of those, how many carried the page's X-Goog-BatchExecute-Bgr header
  let rejectedAt = 0;
  let unreadable = 0;
  await action();
  if (load) seen = 0;
  for (;;) {
    const fresh = await page.evaluate((i) => window.__rpc.slice(i), seen);
    seen += fresh.length;
    for (const r of fresh) {
      if (!r.url.includes(`FlightsFrontendService/${rpc}`)) continue;
      if (r.text == null) { unreadable++; continue; }
      const payloads = parseBatchExecute(r.text).filter((p) => p != null);
      bgrTally[payloads.length ? 'ok' : 'rejected'][r.bgr ? 'bgr' : 'none']++;
      if (payloads.length) return payloads.flatMap(decode);
      rejected++;
      if (r.bgr) rejectedBgr++;
      rejectedAt ||= Date.now();
    }
    if (rejectedAt && Date.now() - rejectedAt > rejectGrace) throw new Rejected(`${step}: ${rpc} rejected (${rejectedBgr} with bgr header), not asked again within ${rejectGrace}ms`);
    if (Date.now() >= deadline) throw new Error(`${step}: no usable ${rpc} response within ${timeout}ms (${rejected} rejected, ${rejectedBgr} of them with bgr header, ${unreadable} unreadable)`);
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
      // Not 'networkidle': Google's pages often never go quiet, so the load hit its 30 s timeout and
      // failed the graph (112 in six sweeps, 2026-11-10). The button wait is the real readiness test.
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
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
    }, 'open graph', GRAPH_TIMEOUT_MS, GRAPH_REJECT_GRACE_MS));
    const fwd = page.getByRole('button', { name: 'Scroll forward' });
    let last = [...cells.keys()].at(-1) ?? start;
    for (let i = 0; i < 12 && last < end; i++) {
      if (addDays(last, span) >= addDays(today(), HORIZON_DAYS - 2)) break; // at the horizon already
      try {
        add(await capture(page, 'GetCalendarGraph', parseCalendar, async () => {
          if (!(await clickAndSend(page, fwd, 'GetCalendarGraph'))) throw new NothingSent();
        }, `scroll ${i + 1}`, GRAPH_TIMEOUT_MS, GRAPH_REJECT_GRACE_MS));
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
  const t0 = Date.now();
  const page = await newPage(ctx, timeout + 60_000);
  const label = `${query.from}-${query.to} ${query.out}`;
  // Phases (page-stats.js): open, nav (to DOMContentLoaded), reply (then to the first usable
  // reply: Google's time plus rejected replies waited out), more, reloadNav, reloadReply.
  const prof = await profile(page, 'search', t0);
  prof.mark('open');
  const go = (phase) => () => page.goto(pageUrl(query), { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS }).finally(() => prof.mark(phase));
  let ok = false;
  try {
    // A rejected reply that the page doesn't ask again for, or a load that sends nothing: loaded
    // again rather than waited out (10% of the checks' pages sat out a 60 s timeout, 13:05 sweep
    // 2026-11-02; an idle page answers in 3-6 s).
    const until = Date.now() + timeout;
    let payloads;
    for (let n = 1; ; n++) {
      const left = until - Date.now();
      try {
        payloads = await capture(page, 'GetShoppingResults', (p) => [p], go('nav'), label,
          n < SHOP_LOADS ? Math.min(left, SHOP_TRY_MS) : left, REJECT_GRACE_MS, true);
        break;
      } catch (e) {
        if (n >= SHOP_LOADS || until - Date.now() < 5_000) throw e;
      } finally { prof.mark('reply'); }
    }
    // The first reply is only Google's "top flights"; the rest (often the cheapest) load behind
    // "View more flights".
    // Its reply is now and then rejected (a null payload) and the page doesn't ask again: waited out
    // for 15 s, the full list was lost (2 of 8 to 3 of 4 pages, locally 2026-11-13). The button is
    // gone after a rejected reply (8:05 pm Vancouver run: 267 of 750 rejected, none clickable again),
    // so the page is loaded again (Google has the search cached by then: ~2-3 s) and clicked again.
    const more = page.getByRole('button', { name: /more flights/i }).first();
    for (let n = 0; n < MORE_TRIES; n++) {
      if (n) {
        moreTally.reloads++;
        try {
          payloads = await capture(page, 'GetShoppingResults', (p) => [p], go('reloadNav'), `${label} again`,
            SHOP_TRY_MS, REJECT_GRACE_MS, true);
        } catch { moreTally.lost++; break; } finally { prof.mark('reloadReply'); } // the first load's top flights kept
      }
      if (!await more.isVisible().catch(() => false)) { if (n) moreTally.lost++; break; }
      try {
        payloads.push(...await capture(page, 'GetShoppingResults', (p) => [p], () => more.click(), `${label} more`, 15_000, MORE_REJECT_MS));
        moreTally[n ? 'okReload' : 'ok']++;
        break;
      } catch (e) {
        moreTally[e instanceof Rejected ? 'rejected' : 'failed']++;
        if (!(e instanceof Rejected)) break; // no reply in 15 s: not waited out again
        if (n === MORE_TRIES - 1) moreTally.lost++;
      } finally { prof.mark('more'); }
    }
    ok = true;
    return payloads;
  } finally {
    await prof.done(ok);
    await page.close();
  }
}

module.exports = { bgrTally, moreTally, openBrowser, newContext, priceGraph, bookingOptions, shoppingResults, addDays };
