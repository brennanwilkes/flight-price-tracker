'use strict';
/* Fetch a Google Flights search page and pull out its inline result payload.
 *
 * Since 2026-08 the FlightsFrontendService RPCs (GetCalendarGraph, GetShoppingResults,
 * GetBookingResults) need a browser-signed `x-goog-batchexecute-bgr` header, so a plain HTTP
 * client gets nothing from them. The public /travel/flights page still inlines the results in
 * an `AF_initDataCallback({key: 'ds:1', ...})` blob (found by punitarani/fli).
 */

const { buildTfs } = require('./tfs');

const PAGE_URL = 'https://www.google.com/travel/flights';

// One consistent, browser-like header set. The UA is load-bearing: without a browser UA the
// page comes back HTTP 200 with no result rows. SOCS is a pre-accepted consent cookie so a
// VPN exit in the EU doesn't get the consent interstitial.
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-CA,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'cookie': 'SOCS=CAISNQgQEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwMzE3LjA5X3AwGgJlbiADGgYIgLC_rwY',
};

function pageUrl(query) {
  return `${PAGE_URL}?tfs=${buildTfs(query)}&hl=en&gl=CA&curr=CAD`;
}

const BLOB = /AF_initDataCallback\((\{[\s\S]*?\})\);/g;

/** Every AF_initDataCallback blob on the page, as { key: data }. */
function extractBlobs(html) {
  const out = {};
  for (const m of html.matchAll(BLOB)) {
    const k = /key:\s*'([^']+)'/.exec(m[1]);
    const d = /data:([\s\S]*?), sideChannel/.exec(m[1]);
    if (!k || !d) continue;
    try { out[k[1]] = JSON.parse(d[1]); } catch { out[k[1]] = undefined; }
  }
  return out;
}

async function fetchPage(query, { timeoutMs = 30_000 } = {}) {
  const url = pageUrl(query);
  const t0 = Date.now();
  const res = await fetch(url, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const html = await res.text();
  return { url, status: res.status, location: res.headers.get('location'), ms: Date.now() - t0, bytes: html.length, html };
}

module.exports = { fetchPage, extractBlobs, pageUrl, HEADERS };
