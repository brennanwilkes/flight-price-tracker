'use strict';
/* Flight details for a priced ticket: which flights Google lists at that price.
 *
 * The price graph only gives a price per date. The search page (plain HTTP, no browser; page.js)
 * inlines its result rows, each with airline, flight numbers, aircraft, times and layovers. For a
 * ticket the caller picks the row whose price is closest to the graph's (trips/details.js).
 */
const { fetchPage, extractBlobs } = require('./page');

const hm = (t) => `${String(t?.[0] ?? 0).padStart(2, '0')}:${String(t?.[1] ?? 0).padStart(2, '0')}`;
const iso = (d) => d && `${d[0]}-${String(d[1]).padStart(2, '0')}-${String(d[2]).padStart(2, '0')}`;

/** Result rows of a search page: [{ price, min, airlines, legs: [...], stops: [{ at, min }] }]. */
function parseOptions(html) {
  const ds1 = extractBlobs(html)['ds:1'];
  if (!ds1) return null;
  const rows = [...(ds1[2]?.[0] ?? []), ...(ds1[3]?.[0] ?? [])];
  return rows.map((row) => {
    const d = row[0];
    return {
      price: row[1]?.[0]?.at(-1) ?? null,
      min: d[9],
      airlines: d[1] ?? [],
      legs: (d[2] ?? []).map((l) => ({
        code: `${l[22]?.[0] ?? ''}${l[22]?.[1] ?? ''}`,
        airline: l[22]?.[3] ?? null,
        from: l[3], to: l[6],
        dep: hm(l[8]), arr: hm(l[10]),
        depDate: iso(l[20]), arrDate: iso(l[21]),
        min: l[11],
        plane: l[17] ?? null,
      })),
      stops: (d[13] ?? []).map((s) => ({ at: s[1], min: s[0] })),
    };
  }).filter((o) => o.price != null && o.legs.length);
}

/** One search's result rows. Google now and then serves a page without them: one retry. */
async function search(query, tries = 2) {
  const r = await fetchPage(query);
  const opts = r.status === 200 ? parseOptions(r.html) : null;
  if (opts) return opts;
  if (tries > 1) return search(query, tries - 1);
  throw new Error(r.status === 200 ? 'no results blob' : `HTTP ${r.status}`);
}

module.exports = { parseOptions, search };
