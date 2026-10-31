// Trip map: Natural Earth coastlines (app/land.js) in Mercator, cropped to the trip's Asian cities.
// Long-haul legs are great circles toward home, leaving the map where they really would, with
// the home city named at the edge. Each city pair is one line (a return trip too), badged with
// its leg numbers from the itinerary list.
import { CITIES, cityName } from './cities.js';
import { LAND, STEP } from './land.js';

const W = 640, H = 480; // viewBox; the crop is grown to this aspect
const PAD = 2.5; // degrees around the cities
const MIN_SPAN = 14; // smallest crop width, degrees of longitude
const HOME = { lon: -123.18, lat: 49.19 }; // YVR; YYJ is the same direction at this scale
const LONG_SHOWN = 5; // of greatCircle's 64 steps (~7° of arc for these routes)

const RAD = Math.PI / 180;
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / RAD;

/** Great circle from a toward b, as [lon, lat] points (lon unwrapped past 180). */
function greatCircle(a, b, n = 64) {
  const [l1, p1, l2, p2] = [a.lon * RAD, a.lat * RAD, b.lon * RAD, b.lat * RAD];
  const v = (l, p) => [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const A = v(l1, p1), B = v(l2, p2);
  const d = Math.acos(A[0] * B[0] + A[1] * B[1] + A[2] * B[2]);
  const pts = [];
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n, s1 = Math.sin((1 - t) * d) / Math.sin(d), s2 = Math.sin(t * d) / Math.sin(d);
    const x = s1 * A[0] + s2 * B[0], y = s1 * A[1] + s2 * B[1], z = s1 * A[2] + s2 * B[2];
    let lon = Math.atan2(y, x) / RAD;
    if (prev != null) while (lon - prev < -180) lon += 360;
    pts.push([lon, Math.atan2(z, Math.hypot(x, y)) / RAD]);
    prev = lon;
  }
  return pts;
}

/**
 * The trip as an SVG. legs: the itinerary in flying order, [{ n, from, to, cabin }], where a code
 * without coordinates (YVR, YYJ) is home.
 */
export function tripMap(legs, home) {
  const onMap = (c) => CITIES[c]?.lon != null;
  const stops = [...new Set(legs.flatMap((l) => [l.from, l.to]).filter(onMap))];
  // Each long-haul city's route home, and a point LONG_SHOWN along it that the crop must include,
  // so the line has room before it leaves the map.
  const gateways = [...new Set(legs.filter((l) => !onMap(l.from) || !onMap(l.to)).map((l) => (onMap(l.from) ? l.from : l.to)))];
  const routes = new Map(gateways.map((c) => [c, greatCircle(CITIES[c], HOME)]));
  const reach = [...routes.values()].map((pts) => pts[LONG_SHOWN]);

  // Crop: the cities plus padding, grown to MIN_SPAN and then to the viewBox aspect (in Mercator units).
  const lons = [...stops.map((c) => CITIES[c].lon), ...reach.map((p) => p[0])];
  const ys = [...stops.map((c) => mercY(CITIES[c].lat)), ...reach.map((p) => mercY(p[1]))];
  let x0 = Math.min(...lons) - PAD, x1 = Math.max(...lons) + PAD;
  let y0 = Math.min(...ys) - PAD, y1 = Math.max(...ys) + PAD;
  if (x1 - x0 < MIN_SPAN) { const g = (MIN_SPAN - (x1 - x0)) / 2; x0 -= g; x1 += g; }
  if ((x1 - x0) / (y1 - y0) > W / H) { const g = ((x1 - x0) * H / W - (y1 - y0)) / 2; y0 -= g; y1 += g; }
  else { const g = ((y1 - y0) * W / H - (x1 - x0)) / 2; x0 -= g; x1 += g; }
  const k = W / (x1 - x0);
  const px = (lon, lat) => [(lon - x0) * k, (y1 - mercY(lat)) * k];
  const pt = (c) => px(CITIES[c].lon, CITIES[c].lat);
  const f = (n) => n.toFixed(1);

  const land = LAND.map((r) => {
    let d = '';
    for (let i = 0; i < r.length; i += 2) {
      const [x, y] = px(r[i] * STEP, r[i + 1] * STEP);
      d += `${i ? 'L' : 'M'}${f(x)} ${f(y)}`;
    }
    return `${d}Z`;
  }).join('');

  // Group legs by unordered city pair: one line each, badged with every leg number on it.
  const pairs = new Map();
  for (const l of legs) {
    const key = [l.from, l.to].sort().join('-');
    if (!pairs.has(key)) pairs.set(key, { a: l.from, b: l.to, cabin: l.cabin, ns: [] });
    pairs.get(key).ns.push(l.n);
  }

  const lines = [], badges = [], exits = [];
  for (const { a, b, cabin, ns } of pairs.values()) {
    const cls = cabin === 'J' ? 'biz' : 'eco';
    const city = onMap(a) ? a : b;
    if (!onMap(a) || !onMap(b)) {
      // Long haul: the great circle toward home, until it leaves the crop.
      const pts = routes.get(city).map(([lon, lat]) => px(lon, lat));
      const inside = ([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H;
      const end = pts.findIndex((p) => !inside(p));
      const seen = pts.slice(0, end < 0 ? pts.length : end + 1);
      lines.push(`<path class="leg ${cls}" d="M${seen.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}"/>`);
      const [ex, ey] = seen[seen.length - 1];
      exits.push({ x: Math.min(Math.max(ex, 0), W), y: Math.min(Math.max(ey, 0), H) });
      const [bx, by] = pts[Math.ceil(LONG_SHOWN / 2)];
      badges.push(badge(bx, by, ns, cls));
      continue;
    }
    // Hop: a gentle arc, always bent the same way for a pair whichever direction it's flown.
    const [p, q] = [pt(a), pt(b)].sort((m, n) => m[0] - n[0] || m[1] - n[1]);
    const mx = (p[0] + q[0]) / 2 - (q[1] - p[1]) * 0.15, my = (p[1] + q[1]) / 2 + (q[0] - p[0]) * 0.15;
    lines.push(`<path class="leg ${cls}" d="M${f(p[0])} ${f(p[1])}Q${f(mx)} ${f(my)} ${f(q[0])} ${f(q[1])}"/>`);
    badges.push(badge((p[0] + 2 * mx + q[0]) / 4, (p[1] + 2 * my + q[1]) / 4, ns, cls));
  }

  // City labels: right of the dot, or left when that would run off the map.
  const dots = stops.map((c) => {
    const [x, y] = pt(c);
    const left = x > W * 0.7;
    return `<circle class="city" cx="${f(x)}" cy="${f(y)}" r="6"/>
      <text class="label" x="${f(x + (left ? -11 : 11))}" y="${f(y + 5)}" text-anchor="${left ? 'end' : 'start'}">${cityName(c)}</text>`;
  }).join('');

  // Home, named where each long-haul line leaves the map: beside the line, on the inner side,
  // so the text never sits on it. Exits close together share one label.
  const near = exits.length === 2 && Math.hypot(exits[0].x - exits[1].x, exits[0].y - exits[1].y) < 120;
  const homeLabel = (near ? [{ x: (exits[0].x + exits[1].x) / 2, y: (exits[0].y + exits[1].y) / 2 }] : exits).map(({ x, y }) => {
    const top = y < 2, right = x > W - 2; // which edge it leaves by
    const lx = right ? W - 10 : x - 12, ly = top ? 26 : y + 28;
    return `<text class="label home" x="${f(lx)}" y="${f(Math.min(ly, H - 10))}" text-anchor="end">${cityName(home)} ↗</text>`;
  }).join('');

  return `<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trip map">
    <rect class="sea" width="${W}" height="${H}"/>
    <path class="land" d="${land}"/>
    ${lines.join('')}${dots}${badges.join('')}${homeLabel}
  </svg>`;
}

function badge(x, y, ns, cls) {
  const text = ns.join(' · ');
  const w = 12 + text.length * 8.5;
  return `<g class="badge ${cls}"><rect x="${(x - w / 2).toFixed(1)}" y="${(y - 12).toFixed(1)}" width="${w.toFixed(1)}" height="24" rx="12"/>
    <text x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="middle">${text}</text></g>`;
}
