// Trip map: Natural Earth coastlines (app/land.js) in Mercator, cropped to the trip's Asian cities.
// Draws each flight actually flown (connections through Manila etc. included), coloured by ticket,
// solid for business and dashed for economy. Long hauls are great circles toward home, leaving the
// map where they really would, with the home city named at the edge. Arrowheads give direction: a
// hop flown both ways is two arcs bending to opposite sides.
import { place, cityName, HOI_AN } from './cities.js';
import { LAND, BORDERS, STEP } from './land.js';

const W = 640, H = 480; // viewBox; the crop is grown to this aspect
const PAD = 2.5; // degrees around the cities
const MIN_SPAN = 14; // smallest crop width, degrees of longitude
// On a phone, a compact trip (cities within COMPACT degrees, e.g. Da Nang and Manila) zooms in further:
// less padding, a shorter stretch of the long haul in frame, a smaller minimum width.
const COMPACT = 20;
const COMPACT_CROP = { pad: 1.5, minSpan: 10, longShown: 3 };
const HOME = { lon: -123.18, lat: 49.19 }; // YVR; YYJ is the same direction at this scale
// Label metrics at the largest label sizes (phones, style.css: 26px names, 21px nights), in
// viewBox units: mono ≈ 0.6em wide.
const CHAR_W = 15.6, CHAR_W_SMALL = 12.6, LINE_H = 28, NIGHTS_H = 24;
const NEAR = 8; // degrees: a connection airport this close to where the trip stays is in frame
const CROWDED_R = 55; // a label pushed further than this from its dot (and further than the closest crop needs): crowded
const LEADER_MAX = 160; // furthest a label sits from its dot
const LONG_SHOWN = 5; // of greatCircle's 64 steps (~7° of arc for these routes)

// The North–South railway, Hanoi to Saigon, roughly (stations as [lon, lat]); DA_NANG is its index.
// Overland legs follow it, Hoi An off it from Da Nang.
const RAIL = [[105.84, 21.02], [105.92, 20.54], [106.17, 20.43], [105.97, 20.25], [105.78, 19.81], [105.67, 18.68],
  [106.03, 17.88], [106.6, 17.47], [107.1, 16.82], [107.58, 16.46], [108.07, 16.25], [108.2, 16.07], [108.48, 15.57],
  [108.8, 15.12], [109.13, 13.8], [109.3, 13.08], [109.18, 12.25], [108.95, 11.58], [108.5, 11.25], [108.03, 10.98],
  [107.24, 10.94], [106.82, 10.95], [106.68, 10.78]];
const DA_NANG = 11;

/** An overland leg as [lon, lat] points: from a along the railway to b. */
function railPath(a, b) {
  const at = (c) => (c === HOI_AN ? DA_NANG : RAIL.reduce((best, [lon, lat], i) => {
    const d = Math.hypot(lon - place(c).lon, lat - place(c).lat);
    return d < best.d ? { i, d } : best;
  }, { i: 0, d: Infinity }).i);
  const [i, j] = [at(a), at(b)];
  const rail = i <= j ? RAIL.slice(i, j + 1) : RAIL.slice(j, i + 1).reverse();
  return [[place(a).lon, place(a).lat], ...rail, [place(b).lon, place(b).lat]];
}

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
 * The trip as an SVG. legs: the flights in flying order, [{ from, to, cabin, tk }], tk being the
 * ticket's colour number; cities: the trip's own cities (any other airport is a connection);
 * stays: city → nights for each overnight stay, noted under the city's name. A code without
 * coordinates (YVR, YYJ, SEA…) is off the map, toward home; a far one (Honolulu: cities.js) is off
 * it toward where it is.
 */
export function tripMap(legs, home, cities, stays = new Map()) {
  // The map frames the whole trip, connection airports included, unless that crowds the cities it
  // stays in (a label pushed out from its dot): then the farthest connection leaves the frame, one
  // at a time, down to those within NEAR degrees of a stay. A flight to one out of frame leaves the
  // map toward it, named there.
  const known = (c) => place(c).lon != null && !place(c).far;
  const overland = new Set(legs.filter((l) => l.ground).flatMap((l) => [l.from, l.to]));
  const all = [...new Set(legs.flatMap((l) => [l.from, l.to]).filter(known))];
  const kept = all.filter((c) => stays.has(c) || overland.has(c));
  const core = kept.length ? kept : all;
  const reach = (c) => Math.min(...core.map((o) => Math.hypot(place(c).lon - place(o).lon, place(c).lat - place(o).lat)));
  const far = all.filter((c) => !core.includes(c) && reach(c) > NEAR).sort((a, b) => reach(a) - reach(b));
  const framed = (n) => new Set(all.filter((c) => !far.includes(c) || far.indexOf(c) < n));
  const tight = render(legs, home, cities, stays, framed(0)); // what the labels need at the closest crop
  for (let n = far.length; n > 0; n--) {
    const map = render(legs, home, cities, stays, framed(n));
    if (!map.hidden && map.reach <= Math.max(CROWDED_R, tight.reach) && map.clash <= tight.clash) return map.svg;
  }
  // A city left off can't fall inside the crop the others make (seen: Manila inside the frame,
  // named as an exit, its flight home not drawn): the closest crop with none inside.
  for (let n = 0; n <= far.length; n++) {
    const map = n ? render(legs, home, cities, stays, framed(n)) : tight;
    if (!map.hidden) return map.svg;
  }
  return tight.svg;
}

/** tripMap's SVG with the cities in `framed` on the map; reach: the furthest a label sits from its dot, clash: what labels cover that they mustn't. */
function render(legs, home, cities, stays, framed) {
  const overland = new Set(legs.filter((l) => l.ground).flatMap((l) => [l.from, l.to]));
  const onMap = (c) => framed.has(c);
  const left = [...new Set(legs.flatMap((l) => [l.from, l.to]))].filter((c) => !onMap(c) && place(c).lon != null);
  legs = legs.filter((l) => onMap(l.from) || onMap(l.to));
  const stops = [...new Set(legs.flatMap((l) => [l.from, l.to]).filter(onMap))];
  // Each flight leaving the frame, from its city on the map toward where it goes ("city>end": an
  // Asian airport out of frame, the far stop, or home), and a point LONG_SHOWN along it that the
  // crop must include, so the line has room before it leaves the map.
  const away = (l) => (onMap(l.from) ? l.to : l.from);
  const toward = (end) => (place(end).lon != null ? end : home); // named where the line leaves the map
  const routeOf = (l) => `${onMap(l.from) ? l.from : l.to}>${toward(away(l))}`;
  const routes = new Map(legs.filter((l) => !onMap(l.from) || !onMap(l.to)).map((l) => {
    const [city, end] = routeOf(l).split('>');
    return [routeOf(l), greatCircle(place(city), place(end).lon != null ? place(end) : HOME)];
  }));
  const cityLons = stops.map((c) => place(c).lon), cityLats = stops.map((c) => place(c).lat);
  const compact = matchMedia('(max-width: 600px)').matches && Math.max(Math.max(...cityLons) - Math.min(...cityLons), Math.max(...cityLats) - Math.min(...cityLats)) < COMPACT;
  const { pad, minSpan, longShown } = compact ? COMPACT_CROP : { pad: PAD, minSpan: MIN_SPAN, longShown: LONG_SHOWN };
  const reach = [...routes.values()].map((pts) => pts[longShown]);

  // Crop: the cities plus padding, grown to MIN_SPAN and then to the viewBox aspect (in Mercator units).
  const lons = [...stops.map((c) => place(c).lon), ...reach.map((p) => p[0])];
  const ys = [...stops.map((c) => mercY(place(c).lat)), ...reach.map((p) => mercY(p[1]))];
  let x0 = Math.min(...lons) - pad, x1 = Math.max(...lons) + pad;
  let y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
  if (x1 - x0 < minSpan) { const g = (minSpan - (x1 - x0)) / 2; x0 -= g; x1 += g; }
  if ((x1 - x0) / (y1 - y0) > W / H) { const g = ((x1 - x0) * H / W - (y1 - y0)) / 2; y0 -= g; y1 += g; }
  else { const g = ((y1 - y0) * W / H - (x1 - x0)) / 2; x0 -= g; x1 += g; }
  const k = W / (x1 - x0);
  const px = (lon, lat) => [(lon - x0) * k, (y1 - mercY(lat)) * k];
  const pt = (c) => px(place(c).lon, place(c).lat);
  const f = (n) => n.toFixed(1);

  const land = LAND.map((r) => {
    let d = '';
    for (let i = 0; i < r.length; i += 2) {
      const [x, y] = px(r[i] * STEP, r[i + 1] * STEP);
      d += `${i ? 'L' : 'M'}${f(x)} ${f(y)}`;
    }
    return `${d}Z`;
  }).join('');
  const borders = BORDERS.map((r) => {
    let d = '';
    for (let i = 0; i < r.length; i += 2) {
      const [x, y] = px(r[i] * STEP, r[i + 1] * STEP);
      d += `${i ? 'L' : 'M'}${f(x)} ${f(y)}`;
    }
    return d;
  }).join('');

  const lines = [], arrows = [], exits = [], drawn = new Map(), once = new Set();
  const trace = []; // points every few units along each line drawn, for the labels to keep off
  const traceOf = (pts) => {
    for (let i = 1; i < pts.length; i++) {
      const [[x0, y0], [x1, y1]] = [pts[i - 1], pts[i]];
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 8);
      for (let j = 0; j < n; j++) trace.push([x0 + ((x1 - x0) * j) / n, y0 + ((y1 - y0) * j) / n]);
    }
  };
  for (const { from: a, to: b, cabin, tk, ground } of legs) {
    if (ground) { // overland (to and from Hoi An): a grey line along the railway, no ticket
      const pts = railPath(a, b).map(([lon, lat]) => px(lon, lat));
      traceOf(pts);
      lines.push(`<path class="ground" d="M${pts.map((p) => p.map(f).join(' ')).join('L')}"/>`);
      continue;
    }
    const cls = `${cabin === 'J' ? 'biz' : 'eco'}" style="--c: var(--tk${tk})`;
    if (!onMap(a) || !onMap(b)) {
      // Leaving the frame: the great circle toward where it goes (from the city), until it leaves the crop.
      const route = routeOf({ from: a, to: b });
      // A second long haul on the same route (another ticket) runs alongside the first.
      const tks = drawn.get(route) ?? [];
      if (!tks.includes(tk)) tks.push(tk);
      drawn.set(route, tks);
      const k = tks.indexOf(tk);
      const raw = routes.get(route).map(([lon, lat]) => px(lon, lat));
      const pts = raw.map(([x, y], i) => {
        const [p, q] = [raw[Math.max(i - 1, 0)], raw[Math.min(i + 1, raw.length - 1)]];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
        return [x - ((q[1] - p[1]) / len) * 6 * k, y + ((q[0] - p[0]) / len) * 6 * k];
      });
      const inside = ([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H;
      const end = pts.findIndex((p) => !inside(p));
      const seen = pts.slice(0, end < 0 ? pts.length : end + 1);
      if (!once.has(`${route}|${tk}`)) { // a return ticket's two flights share one line
        once.add(`${route}|${tk}`);
        lines.push(`<path class="leg ${cls}" d="M${seen.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}"/>`);
        traceOf(seen);
        const [ex, ey] = seen[seen.length - 1];
        const [qx, qy] = seen[Math.max(0, seen.length - 2)];
        if (!k) exits.push({ x: Math.min(Math.max(ex, 0), W), y: Math.min(Math.max(ey, 0), H), dx: ex - qx, dy: ey - qy, name: cityName(route.split('>')[1]) });
      }
      // Inbound arrow nearer the city, outbound one further along; each points the way flown.
      const j = Math.max(1, Math.min(seen.length - 2, onMap(b) ? 1 : 3));
      const [p0, p1] = onMap(b) ? [seen[j + 1], seen[j - 1]] : [seen[j - 1], seen[j + 1]];
      arrows.push(arrow((seen[j][0]), seen[j][1], p1[0] - p0[0], p1[1] - p0[1], cls));
      continue;
    }
    // Hop: an arc bent to the right of its direction, so there and back are two separate arcs.
    const [p, q] = [pt(a), pt(b)];
    const mx = (p[0] + q[0]) / 2 - (q[1] - p[1]) * 0.18, my = (p[1] + q[1]) / 2 + (q[0] - p[0]) * 0.18;
    lines.push(`<path class="leg ${cls}" d="M${f(p[0])} ${f(p[1])}Q${f(mx)} ${f(my)} ${f(q[0])} ${f(q[1])}"/>`);
    traceOf(Array.from({ length: 17 }, (_, i) => { const t = i / 16; return [(1 - t) ** 2 * p[0] + 2 * t * (1 - t) * mx + t * t * q[0], (1 - t) ** 2 * p[1] + 2 * t * (1 - t) * my + t * t * q[1]]; }));
    // Arc midpoint and its tangent (the chord direction there).
    arrows.push(arrow((p[0] + 2 * mx + q[0]) / 4, (p[1] + 2 * my + q[1]) / 4, q[0] - p[0], q[1] - p[1], cls));
  }

  // City labels, named only where the trip spends a night (or an overland stretch starts or
  // ends): a city only changed planes in keeps its dot, the route runs through it. Connection
  // airports smaller and hollow. Each label (name, nights under it) goes to the nearest spot
  // around its dot, out to LEADER_MAX, that covers no other label, dot or the map's edge and as
  // little of the flown lines as it can; moved out from the dot it gets a thin leader line.
  // Crowded cities pick first, then each label is placed again around all the others.
  const labelled = stops.filter((c) => stays.has(c) || overland.has(c));
  const nightsOf = (c) => (stays.has(c) ? `${stays.get(c).join(' + ')} night${stays.get(c).join() === '1' ? '' : 's'}` : '');
  const sizeOf = (c) => {
    const nights = nightsOf(c);
    return { nights, w: Math.max(cityName(c).length * CHAR_W, nights.length * CHAR_W_SMALL), h: nights ? LINE_H + NIGHTS_H : LINE_H };
  };
  /** The label's box with its nearest side or corner `r` from the dot, toward angle `a`. */
  const layout = (c, a, r) => {
    const [x, y] = pt(c);
    const { nights, w, h } = sizeOf(c);
    const dx = Math.cos(a), dy = Math.sin(a);
    const ax = x + dx * r, ay = y + dy * r;
    const anchor = dx > 0.35 ? 'start' : dx < -0.35 ? 'end' : 'middle';
    const x0 = anchor === 'start' ? ax : anchor === 'end' ? ax - w : ax - w / 2;
    const y0 = dy > 0.35 ? ay : dy < -0.35 ? ay - h : ay - LINE_H / 2;
    return { c, nights, anchor, r, x0, x1: x0 + w, y0, y1: y0 + h, tx: anchor === 'start' ? x0 : anchor === 'end' ? x0 + w : x0 + w / 2 };
  };
  const tries = (c) => [11, 30, 55, 85, 120, LEADER_MAX].flatMap((r) => Array.from({ length: 16 }, (_, i) => layout(c, (i * Math.PI) / 8, r)));
  const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const dotBoxes = stops.map((c) => { const [x, y] = pt(c); return { c, x0: x - 8, x1: x + 8, y0: y - 8, y1: y + 8 }; });
  const inBox = (b, [x, y]) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;
  const placed = new Map();
  // What a label covers that it mustn't: other labels and dots, and past the map's edge.
  const clash = (b) => {
    let s = 0;
    for (const o of placed.values()) if (o.c !== b.c) s += overlap(b, o);
    for (const d of dotBoxes) if (d.c !== b.c) s += overlap(b, d);
    return s + (b.x1 - b.x0) * (b.y1 - b.y0) - overlap(b, { x0: 4, x1: W - 4, y0: 4, y1: H - 4 });
  };
  const score = (b) => 30 * clash(b) + 40 * trace.filter((p) => inBox(b, p)).length + 6 * b.r;
  const crowd = (c) => stops.filter((o) => o !== c && Math.hypot(pt(o)[0] - pt(c)[0], pt(o)[1] - pt(c)[1]) < 150).length;
  const order = [...labelled].sort((a, b) => crowd(b) - crowd(a));
  for (let pass = 0; pass < 3; pass++) {
    for (const c of order) {
      let best = null, bestScore = Infinity;
      for (const t of tries(c)) { const sc = score(t); if (sc < bestScore) { best = t; bestScore = sc; } }
      placed.set(c, best);
    }
  }
  const furthest = Math.max(0, ...[...placed.values()].map((l) => l.r));
  const clashes = [...placed.values()].reduce((n, l) => n + clash(l), 0);
  const boxes = [...placed.values()]; // home's label keeps clear of them too
  const dots = stops.map((c) => {
    const [x, y] = pt(c);
    const via = !cities.includes(c);
    return `<circle class="city${via ? ' via' : ''}" cx="${f(x)}" cy="${f(y)}" r="${via ? 4.5 : 6}"/>`;
  }).join('');
  const labels = [...placed.values()].map((l) => {
    const [x, y] = pt(l.c);
    const via = !cities.includes(l.c);
    // Leader: from the dot to the box's nearest point.
    const lx = Math.min(Math.max(x, l.x0), l.x1), ly = Math.min(Math.max(y, l.y0), l.y1);
    const leader = l.r > 11 ? `<line class="leader" x1="${f(x)}" y1="${f(y)}" x2="${f(lx)}" y2="${f(ly)}"/>` : '';
    return `${leader}
      <text class="label${via ? ' via' : ''}" x="${f(l.tx)}" y="${f(l.y0 + LINE_H / 2)}" dominant-baseline="middle" text-anchor="${l.anchor}">${cityName(l.c)}</text>${l.nights ? `
      <text class="label nights" x="${f(l.tx)}" y="${f(l.y0 + LINE_H + NIGHTS_H / 2)}" dominant-baseline="middle" text-anchor="${l.anchor}">${l.nights}</text>` : ''}`;
  });

  // Where each line leaving the frame goes (home, the far stop, an airport out of frame), named
  // by the edge it leaves through, at the nearest spot there clear of the city labels, dots and
  // lines. Each place is named once.
  const named = exits.filter((e, i) => exits.findIndex((o) => o.name === e.name) === i); // one label per place
  const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  const homeLabel = named.map(({ x, y, dx, dy, name }) => {
    const text = `${name} ${ARROWS[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8]}`;
    const w = text.length * CHAR_W, M = 8;
    const edge = y < 2 ? 'top' : y > H - 2 ? 'bottom' : x < 2 ? 'left' : 'right';
    const clampX = (v) => Math.min(Math.max(v, M), W - M - w), clampY = (v) => Math.min(Math.max(v, M), H - M - LINE_H);
    const tries = Array.from({ length: 17 }, (_, i) => (i - 8) * 30).flatMap((d) => [0, LINE_H + 4].map((inset) => {
      const x0 = edge === 'top' || edge === 'bottom' ? clampX(x - w / 2 + d) : edge === 'left' ? M + inset : W - M - w - inset;
      const y0 = edge === 'left' || edge === 'right' ? clampY(y - LINE_H / 2 + d) : edge === 'top' ? M + inset : H - M - LINE_H - inset;
      return { x0, x1: x0 + w, y0, y1: y0 + LINE_H };
    }));
    const score = (b) => boxes.reduce((s, o) => s + 30 * overlap(b, o), 0) + dotBoxes.reduce((s, d) => s + 30 * overlap(b, d), 0)
      + trace.filter((p) => inBox(b, p)).length * 15 + 3 * Math.hypot((b.x0 + b.x1) / 2 - x, (b.y0 + b.y1) / 2 - y);
    const b = tries.reduce((a, t) => (score(t) < score(a) ? t : a));
    boxes.push(b); // the next exit's label keeps clear
    return `<text class="label home" x="${f(b.x0)}" y="${f(b.y0 + LINE_H / 2)}" dominant-baseline="middle">${text}</text>`;
  }).join('');

  const hidden = left.filter((c) => { const [x, y] = pt(c); return x >= 0 && x <= W && y >= 0 && y <= H; }).length;
  return { reach: furthest, clash: clashes, hidden, svg: `<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trip map">
    <rect class="sea" width="${W}" height="${H}"/>
    <path class="land" d="${land}"/>
    <path class="border" d="${borders}"/>
    ${lines.join('')}${arrows.join('')}${dots}${labels.join('')}${homeLabel}
  </svg>` };
}

/** A filled arrowhead at (x, y) pointing along (dx, dy). */
function arrow(x, y, dx, dy, cls) {
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return `<path class="arrow ${cls}" d="M9 0L-7 -8L-3 0L-7 8Z" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${deg.toFixed(1)})"/>`;
}
