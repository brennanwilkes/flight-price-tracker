// Hand-drawn trip map: rough coastlines, city dots, one arc per flight. Plain equirectangular at
// 10 px per degree, cropped to the trip's cities; the Pacific legs leave off the right edge.
import { CITIES, cityName } from './cities.js';

const K = 10;
const PAD = 3; // degrees around the cities
const MIN_W = 24, MIN_H = 14; // smallest crop, degrees

// Rough outlines (lon, lat), good enough to place the cities, not a real map.
const LAND = [
  // Mainland: Malay peninsula, Gulf of Thailand, Vietnam, China, Korea
  [[98.5, 8], [100.3, 5.5], [101.3, 2.8], [103.5, 1.3], [104.2, 1.5], [103.4, 4.5], [102.2, 6.2], [100.4, 7.6], [99.9, 9.3],
    [100, 12.5], [100.9, 13.4], [101.5, 12.7], [102.5, 12], [103.5, 10.5], [104.8, 8.6], [106.7, 10.4], [107.5, 10.5],
    [109.2, 11.7], [109.3, 13.5], [108.9, 15.3], [108.2, 16.1], [107, 17], [105.8, 18.8], [106.6, 20.4], [108, 21.5],
    [109.7, 21.5], [110.3, 20.3], [111, 21.5], [113.5, 22.2], [116.5, 23], [119.5, 25.5], [121.5, 28.5], [122, 30.8],
    [120.5, 33], [119.2, 35], [120.5, 36.3], [122.5, 37], [120.8, 37.8], [118.8, 38], [117.7, 39], [119.5, 39.9],
    [121.5, 39], [122.2, 40.5], [124.3, 39.9], [125.2, 38.6], [126.1, 37.7], [126.5, 36.8], [126.3, 34.6], [127.5, 34.6],
    [129.3, 35.3], [129.4, 36.5], [128.6, 38.4], [129.7, 41], [130.5, 43], [95, 43], [95, 15], [97.6, 16.5], [98.5, 8]],
  [[108.6, 19.2], [109.5, 18.3], [110.5, 18.5], [111, 19.7], [110.6, 20.1], [109.5, 20]], // Hainan
  [[120.1, 23], [120.7, 22], [121, 22.5], [121.9, 24.8], [121.5, 25.3], [120.7, 24.6]], // Taiwan
  [[120.6, 18.5], [122.2, 18.5], [122, 16], [121.6, 14.2], [124, 13], [123.5, 12.6], [120.6, 13.8], [120, 16]], // Luzon
  [[122, 7], [124, 6], [126.5, 6.5], [126.2, 9.3], [123.5, 10.5], [122.5, 9]], // Mindanao and Visayas, roughly
  [[109, 1.5], [110, 2], [113, 3.2], [115.5, 5.5], [117.3, 6.9], [119, 5.2], [118, 1], [116.5, -2], [110, -2]], // Borneo
  [[95.3, 5.6], [97.5, 5.2], [100.3, 2], [103.7, -1], [104, -2], [101, -2], [98, 1.5]], // Sumatra
  [[130.9, 33.9], [132.5, 34.3], [135, 34.6], [135.8, 33.5], [137, 34.6], [139, 34.7], [140, 35], [140.9, 36], [141, 38.3],
    [141.9, 39.6], [141.4, 41.4], [140, 40.7], [140, 39.5], [139.6, 38], [138.5, 37.4], [137.3, 36.8], [136.7, 37.3],
    [136, 35.7], [133.2, 35.5], [131.4, 34.4]], // Honshu
  [[129.7, 33.5], [130, 32.3], [130.6, 31.2], [131.4, 31.4], [131.9, 32.9], [131, 33.9]], // Kyushu
  [[132.5, 33], [134.7, 33.8], [134, 34.4], [133, 34]], // Shikoku
];

const onMap = (code) => CITIES[code]?.lon != null;

function arc(xy, a, b, cls) {
  const [x1, y1] = xy(a);
  const [x2, y2] = xy(b);
  // Bend left of the direction of travel, more for longer flights.
  const mx = (x1 + x2) / 2 + (y2 - y1) * 0.18, my = (y1 + y2) / 2 - (x2 - x1) * 0.18;
  return `<path class="${cls}" d="M${x1} ${y1} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2} ${y2}"/>`;
}

export function tripMap(trip, home) {
  const flights = trip.tickets.flatMap((t) => (t.kind === 'rt' ? [[t.from, t.to, t.cabin], [t.to, t.from, t.cabin]] : [[t.from, t.to, t.cabin]]));
  const stops = [...new Set(flights.flatMap(([a, b]) => [a, b]))].filter(onMap);
  const lons = stops.map((c) => CITIES[c].lon), lats = stops.map((c) => CITIES[c].lat);
  // Crop: the cities plus padding, grown to a minimum size, with room on the right for the home arrow.
  let w = Math.min(...lons) - PAD, e = Math.max(...lons) + PAD + 6, s = Math.min(...lats) - PAD, n = Math.max(...lats) + PAD;
  if (e - w < MIN_W) { const g = (MIN_W - (e - w)) / 2; w -= g; e += g; }
  if (n - s < MIN_H) { const g = (MIN_H - (n - s)) / 2; s -= g; n += g; }
  const home_ = [e, n - 1]; // the Pacific legs leave from here
  const at = (code) => (onMap(code) ? [CITIES[code].lon, CITIES[code].lat] : home_);
  const xy = (code) => { const [lon, lat] = Array.isArray(code) ? code : at(code); return [+((lon - w) * K).toFixed(1), +((n - lat) * K).toFixed(1)]; };

  const land = LAND.map((p) => `<path d="M${p.map((q) => xy(q).join(' ')).join('L')}Z"/>`).join('');
  const dots = stops.map((c) => {
    const [x, y] = xy(c);
    return `<circle cx="${x}" cy="${y}" r="5"/><text x="${x + 8}" y="${y + 18}">${cityName(c)}</text>`;
  }).join('');
  const [hx, hy] = xy(home_);
  return `<svg class="map" viewBox="0 0 ${((e - w) * K).toFixed(0)} ${((n - s) * K).toFixed(0)}" role="img" aria-label="Trip map">
    <g class="land">${land}</g>
    ${flights.map(([a, b, cabin]) => arc(xy, a, b, cabin === 'J' ? 'leg biz' : 'leg eco')).join('')}
    <g class="dots">${dots}</g>
    <text class="home" x="${hx - 6}" y="16" text-anchor="end">${cityName(home)} →</text>
  </svg>`;
}
