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

module.exports = { parseBatchExecute, parseCalendar };
