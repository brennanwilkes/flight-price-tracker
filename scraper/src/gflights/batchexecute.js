'use strict';
/* Parse a FlightsFrontendService batchexecute response body:
 *   )]}'\n\n<len>\n[["wrb.fr",null,"<json payload>",...],...]\n<len>\n[...]
 * Returns each wrb.fr payload, JSON-decoded. A gated or rejected call comes back as a wrb.fr
 * row with a null payload (error 13), which surfaces here as `null`.
 */
function parseBatchExecute(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('[[')) continue;
    let rows;
    try { rows = JSON.parse(line); } catch { continue; }
    for (const row of rows) {
      if (row[0] !== 'wrb.fr') continue;
      out.push(row[2] == null ? null : JSON.parse(row[2]));
    }
  }
  return out;
}

/** GetCalendarGraph / GetCalendarGrid payload → [{ out, ret, price }] (price null = no fare). */
function parseCalendar(payload) {
  return (payload?.[1] ?? []).map((c) => ({ out: c[0], ret: c[1] ?? null, price: c[2]?.[0]?.[1] ?? null }));
}
/**
 * GetBookingResults payload → [{ seller, sellerName, airlineDirect, price, fare, cabins, matchesCabin }].
 * Booking rows are found by shape anywhere in the payload (layout from punitarani/fli):
 *   row[0] int, row[1][0] = [code, name, _, isAirline], row[7][0].at(-1) = price, row[21][3] = fare brand.
 * Our additions (2026-10-30 capture): row[21][6][i][0] = cabin per flight leg (1 economy … 3 business),
 * row[24] = true when the fare is outside the searched cabin. An airline lists its economy brands
 * inside a business search, so "cheapest airline-direct" must filter on matchesCabin.
 */
function parseBooking(payload) {
  const out = [];
  (function walk(node) {
    if (!Array.isArray(node)) return;
    const v = node[1]?.[0];
    if (node.length >= 8 && Number.isInteger(node[0]) && Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') {
      const price = node[7]?.[0]?.at?.(-1);
      out.push({
        seller: v[0],
        sellerName: v[1],
        airlineDirect: v[3] === true,
        price: typeof price === 'number' ? price : null,
        fare: (typeof node[21]?.[3] === 'string' && node[21][3]) || null,
        cabins: Array.isArray(node[21]?.[6]) ? node[21][6].map((leg) => leg?.[0] ?? null) : null,
        matchesCabin: node[24] !== true,
      });
      return;
    }
    for (const child of node) walk(child);
  })(payload);
  return out;
}

module.exports = { parseBatchExecute, parseCalendar, parseBooking };
