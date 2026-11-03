// Google Flights `tfs` search parameter, the same encoding as scraper/src/gflights/tfs.js
// (a protobuf in URL-safe base64), so a ticket link opens the exact search that was priced.

const CABIN = { Y: 1, W: 2, J: 3, F: 4 };
const text = new TextEncoder();

function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}
const vfield = (field, n) => [...varint(field << 3), ...varint(n)];
function bytes(field, payload) {
  const b = typeof payload === 'string' ? [...text.encode(payload)] : payload;
  return [...varint((field << 3) | 2), ...varint(b.length), ...b];
}
const segment = (from, to, date) => bytes(3, [
  ...bytes(2, date),
  ...[from].flat().flatMap((c) => bytes(13, [...vfield(1, 1), ...bytes(2, c)])),
  ...[to].flat().flatMap((c) => bytes(14, [...vfield(1, 1), ...bytes(2, c)])),
]);

/** One-way, or round trip when `ret` is given. `from` / `to`: an IATA code or a list of them. */
export function buildTfs({ from, to, out, ret = null, cabin = 'Y' }) {
  const parts = [...vfield(1, 28), ...vfield(2, 2), ...segment(from, to, out)];
  if (ret) parts.push(...segment(to, from, ret));
  parts.push(...vfield(8, 1), ...vfield(9, CABIN[cabin] ?? 1), ...vfield(14, 1), ...vfield(19, ret ? 1 : 2));
  return btoa(String.fromCharCode(...parts)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
