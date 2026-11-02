// Trips files with each distinct ticket stored once: a ticket (flights and all, ~2 KB) recurs in
// many rows, months, length bands and long-haul caps. packJson writes trips' `tickets` as indexes
// into a top-level `ticketTable`; unpack puts the tickets back (files without a table pass through).

/** The JSON text of a trips file, tickets shared. */
export function packJson(data) {
  const index = new Map();
  const body = JSON.stringify(data, function (key, value) {
    if (key !== 'tickets' || !Array.isArray(value) || !value.some((t) => t && typeof t === 'object')) return value;
    return value.map((t) => {
      const s = JSON.stringify(t);
      if (!index.has(s)) index.set(s, index.size);
      return index.get(s);
    });
  });
  return `${body.slice(0, -1)},"ticketTable":[${[...index.keys()].join(',')}]}`;
}

/** A parsed trips file with its tickets back in place. */
export function unpack(data) {
  const table = data?.ticketTable;
  if (!table) return data;
  delete data.ticketTable;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const x of o) walk(x); return; }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'tickets' && Array.isArray(v) && typeof v[0] === 'number') o[k] = v.map((i) => table[i]);
      else walk(v);
    }
  };
  walk(data);
  return data;
}
