'use strict';
/* Google Flights `tfs` query parameter: a protobuf, URL-safe base64 without padding.
 *
 * Field layout reverse-engineered by punitarani/fli (fli/search/_proto.py, MIT); we encode
 * only what we search with:
 *
 *   1 = 28, 2 = 2 (constants)          8  = passenger kind, repeated (1 = adult)
 *   3 = segment, repeated              9  = cabin (1 economy, 2 premium, 3 business, 4 first)
 *     3.2  = departure date            14 = 1 (constant)
 *     3.5  = stop ceiling              19 = 1 round trip, 2 one-way, 3 multi-city
 *     3.8  = earliest departure hour (0-23; the page's Times filter, probed 2026-11-02)
 *     3.13 = origin  3.14 = destination   (each {1: 1, 2: IATA}, repeated for multi-airport)
 * `from` / `to` take one IATA code or an array (Tokyo = ['NRT', 'HND']).
 */

const CABIN = { Y: 1, W: 2, J: 3, F: 4 };

function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}
const key = (field, wire) => varint((field << 3) | wire);
const vfield = (field, n) => Buffer.concat([key(field, 0), varint(n)]);
function bytes(field, payload) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return Buffer.concat([key(field, 2), varint(b.length), b]);
}

// A chosen flight, {from, date, to, airline, number}: segment field 4 (round trip: the outbound's
// flights, so the page lists that ticket's returns).
const flight = (f) => bytes(4, Buffer.concat([bytes(1, f.from), bytes(2, f.date), bytes(3, f.to), bytes(5, f.airline), bytes(6, f.number)]));

function segment({ from, to, date, maxStops = null, after = null, selected = null }) {
  const parts = [bytes(2, date)];
  for (const f of selected ?? []) parts.push(flight(f));
  if (maxStops != null) parts.push(vfield(5, maxStops));
  if (after) parts.push(vfield(8, after));
  for (const code of [from].flat()) parts.push(bytes(13, Buffer.concat([vfield(1, 1), bytes(2, code)])));
  for (const code of [to].flat()) parts.push(bytes(14, Buffer.concat([vfield(1, 1), bytes(2, code)])));
  return bytes(3, Buffer.concat(parts));
}

/**
 * Round trip if `ret` is given, multi-city (one ticket) if `legs` ([{ from, to, date }]) is, else
 * one-way. Dates are YYYY-MM-DD. `after`: only flights leaving at or after that hour on `out`.
 */
function buildTfs({ from, to, out, ret = null, legs = null, cabin = 'Y', maxStops = null, after = null, selected = null }) {
  if (!CABIN[cabin]) throw new Error(`unknown cabin ${cabin}`);
  if (legs) {
    return Buffer.concat([vfield(1, 28), vfield(2, 2), ...legs.map((l) => segment({ ...l, maxStops })),
      vfield(8, 1), vfield(9, CABIN[cabin]), vfield(14, 1), vfield(19, 3)]).toString('base64url');
  }
  const parts = [vfield(1, 28), vfield(2, 2), segment({ from, to, date: out, maxStops, after, selected })];
  if (ret) parts.push(segment({ from: to, to: from, date: ret, maxStops }));
  parts.push(vfield(8, 1), vfield(9, CABIN[cabin]), vfield(14, 1), vfield(19, ret ? 1 : 2));
  return Buffer.concat(parts).toString('base64url');
}

module.exports = { buildTfs, CABIN };
