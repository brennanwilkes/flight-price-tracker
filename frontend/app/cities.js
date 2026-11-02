// Cities the trips are built from (SCOPE, coverage). role: gateway = long legs from home and hops;
// hop = hops only. airports: what Google is asked for (default: the code itself). vietnam: an
// anchor for the Hoi An stay, with the ground days from there to Hoi An each way; vn: in Vietnam,
// not an anchor.
export const CITIES = {
  YVR: { name: 'Vancouver', role: 'home' },
  YYJ: { name: 'Victoria', role: 'home' },
  DAD: { name: 'Da Nang', lon: 108.2, lat: 16.05, role: 'gateway', vietnam: 0 },
  HUI: { name: 'Hue', lon: 107.7, lat: 16.4, role: 'hop', vietnam: 0 },
  HAN: { name: 'Hanoi', lon: 105.8, lat: 21.22, role: 'gateway', vietnam: 1 },
  SGN: { name: 'Saigon', lon: 106.66, lat: 10.82, role: 'gateway', vietnam: 1 },
  ICN: { name: 'Seoul', lon: 126.45, lat: 37.46, role: 'gateway' },
  TPE: { name: 'Taipei', lon: 121.23, lat: 25.08, role: 'gateway' },
  HKG: { name: 'Hong Kong', lon: 113.92, lat: 22.31, role: 'gateway' },
  TYO: { name: 'Tokyo', lon: 139.78, lat: 35.55, role: 'gateway', airports: ['NRT', 'HND'] },
  OSA: { name: 'Osaka', lon: 135.24, lat: 34.43, role: 'gateway', airports: ['KIX', 'ITM'] },
  SHA: { name: 'Shanghai', lon: 121.8, lat: 31.14, role: 'gateway', airports: ['PVG', 'SHA'] },
  BJS: { name: 'Beijing', lon: 116.6, lat: 40.08, role: 'gateway', airports: ['PEK', 'PKX'] },
  CAN: { name: 'Guangzhou', lon: 113.3, lat: 23.39, role: 'gateway' },
  MNL: { name: 'Manila', lon: 121.02, lat: 14.51, role: 'gateway' },
  CEB: { name: 'Cebu', lon: 123.98, lat: 10.31, role: 'gateway' },
  SIN: { name: 'Singapore', lon: 103.99, lat: 1.36, role: 'gateway' },
  BKK: { name: 'Bangkok', lon: 100.75, lat: 13.69, role: 'gateway', airports: ['BKK', 'DMK'] },
  KUL: { name: 'Kuala Lumpur', lon: 101.71, lat: 2.74, role: 'gateway' },
  JKT: { name: 'Jakarta', lon: 106.66, lat: -6.13, role: 'gateway', airports: ['CGK'] },
  DPS: { name: 'Bali', lon: 115.17, lat: -8.75, role: 'gateway' },
  REP: { name: 'Siem Reap', lon: 104.22, lat: 13.37, role: 'hop', airports: ['SAI'] },
  PNH: { name: 'Phnom Penh', lon: 104.84, lat: 11.55, role: 'hop', airports: ['KTI'] },
  LPQ: { name: 'Luang Prabang', lon: 102.16, lat: 19.9, role: 'hop' },
  PQC: { name: 'Phu Quoc', lon: 103.99, lat: 10.17, role: 'hop', vn: true },
  CXR: { name: 'Nha Trang', lon: 109.22, lat: 12.0, role: 'hop', vn: true },
  CNX: { name: 'Chiang Mai', lon: 98.96, lat: 18.77, role: 'hop' },
  HKT: { name: 'Phuket', lon: 98.32, lat: 8.11, role: 'hop' },
  KBV: { name: 'Krabi', lon: 98.99, lat: 8.1, role: 'hop' },
  PEN: { name: 'Penang', lon: 100.28, lat: 5.3, role: 'hop' },
  LGK: { name: 'Langkawi', lon: 99.73, lat: 6.33, role: 'hop' },
  BKI: { name: 'Kota Kinabalu', lon: 116.05, lat: 5.94, role: 'hop' },
  FUK: { name: 'Fukuoka', lon: 130.45, lat: 33.59, role: 'hop' },
  CTS: { name: 'Sapporo', lon: 141.69, lat: 42.78, role: 'hop' },
  OKA: { name: 'Okinawa', lon: 127.65, lat: 26.2, role: 'hop' },
  PUS: { name: 'Busan', lon: 128.94, lat: 35.18, role: 'hop' },
  CJU: { name: 'Jeju', lon: 126.49, lat: 33.51, role: 'hop' },
  KHH: { name: 'Kaohsiung', lon: 120.35, lat: 22.58, role: 'hop' },
  JOG: { name: 'Yogyakarta', lon: 110.06, lat: -7.9, role: 'hop', airports: ['YIA'] },
  LOP: { name: 'Lombok', lon: 116.28, lat: -8.76, role: 'hop' },
  PPS: { name: 'Puerto Princesa', lon: 118.76, lat: 9.74, role: 'hop' },
  MPH: { name: 'Boracay', lon: 121.95, lat: 11.92, role: 'hop', airports: ['MPH', 'KLO'] },
  IAO: { name: 'Siargao', lon: 126.01, lat: 9.86, role: 'hop' },
  MFM: { name: 'Macau', lon: 113.59, lat: 22.15, role: 'hop' },
  BWN: { name: 'Brunei', lon: 114.93, lat: 4.94, role: 'hop' },
  DLI: { name: 'Da Lat', lon: 108.38, lat: 11.75, role: 'hop', vn: true },
  SYX: { name: 'Hainan', lon: 109.41, lat: 18.3, role: 'hop', airports: ['SYX', 'HAK'] },
};

/** Whether a city is in Vietnam (rows don't name it, inVietnam's users: build.js setOf). */
export const inVietnam = (c) => CITIES[c]?.vietnam != null || !!CITIES[c]?.vn;
/** Codes of the Asia cities with the given role(s). */
export const citiesWith = (...roles) => Object.keys(CITIES).filter((c) => roles.includes(CITIES[c].role));
/** What Google is asked for: one airport code, or several. */
export const airportsOf = (city) => {
  const a = CITIES[city]?.airports ?? [city];
  return a.length === 1 ? a[0] : a;
};

// Airports flights connect through (the map draws them as stops). Destinations' own airports are
// the CITIES entries above where the codes match.
export const AIRPORTS = {
  NRT: { name: 'Tokyo', lon: 140.39, lat: 35.77 }, HND: { name: 'Tokyo', lon: 139.78, lat: 35.55 },
  KIX: { name: 'Osaka', lon: 135.24, lat: 34.43 }, NGO: { name: 'Nagoya', lon: 136.81, lat: 34.86 },
  FUK: { name: 'Fukuoka', lon: 130.45, lat: 33.59 }, OKA: { name: 'Okinawa', lon: 127.65, lat: 26.2 },
  PUS: { name: 'Busan', lon: 128.94, lat: 35.18 }, CJU: { name: 'Jeju', lon: 126.49, lat: 33.51 },
  PVG: { name: 'Shanghai', lon: 121.8, lat: 31.14 }, PEK: { name: 'Beijing', lon: 116.6, lat: 40.08 },
  PKX: { name: 'Beijing', lon: 116.41, lat: 39.51 }, CAN: { name: 'Guangzhou', lon: 113.3, lat: 23.39 },
  SZX: { name: 'Shenzhen', lon: 113.81, lat: 22.64 }, XMN: { name: 'Xiamen', lon: 118.13, lat: 24.54 },
  CTU: { name: 'Chengdu', lon: 103.95, lat: 30.58 }, KMG: { name: 'Kunming', lon: 102.93, lat: 25.1 },
  MFM: { name: 'Macau', lon: 113.59, lat: 22.15 }, KHH: { name: 'Kaohsiung', lon: 120.35, lat: 22.58 },
  CEB: { name: 'Cebu', lon: 123.98, lat: 10.31 }, CRK: { name: 'Clark', lon: 120.56, lat: 15.19 },
  CGK: { name: 'Jakarta', lon: 106.66, lat: -6.13 }, DPS: { name: 'Bali', lon: 115.17, lat: -8.75 },
  DMK: { name: 'Bangkok', lon: 100.61, lat: 13.91 }, HKT: { name: 'Phuket', lon: 98.32, lat: 8.11 },
  CNX: { name: 'Chiang Mai', lon: 98.96, lat: 18.77 }, PNH: { name: 'Phnom Penh', lon: 104.84, lat: 11.55 },
  REP: { name: 'Siem Reap', lon: 103.81, lat: 13.41 }, RGN: { name: 'Yangon', lon: 96.13, lat: 16.91 },
  VTE: { name: 'Vientiane', lon: 102.56, lat: 17.99 }, PEN: { name: 'Penang', lon: 100.28, lat: 5.3 },
  BKI: { name: 'Kota Kinabalu', lon: 116.05, lat: 5.94 }, BWN: { name: 'Brunei', lon: 114.93, lat: 4.94 },
  SAI: { name: 'Siem Reap', lon: 104.22, lat: 13.37 }, KTI: { name: 'Phnom Penh', lon: 104.84, lat: 11.55 },
  YIA: { name: 'Yogyakarta', lon: 110.06, lat: -7.9 }, ITM: { name: 'Osaka', lon: 135.44, lat: 34.79 },
  KLO: { name: 'Boracay', lon: 122.38, lat: 11.68 },
};

/** Name and map position for a city or airport code (no position: home, or off the map). */
// Hoi An: no airport, on the map only (the stay, reached overland: build.js anchors).
export const HOI_AN = 'HOI';
const HOI_AN_PLACE = { name: 'Hoi An', lon: 108.33, lat: 15.88 };
export const place = (code) => (code === HOI_AN ? HOI_AN_PLACE : CITIES[code] ?? AIRPORTS[code] ?? { name: code });
export const cityName = (code) => place(code).name;
/** A board row's name: "Bangkok / Bali + Hanoi" (crossing, then throw-ins; build.js setOf). */
export const rowName = (r) => [r.in === r.out ? cityName(r.in) : `${cityName(r.in)} / ${cityName(r.out)}`, ...(r.set ? r.set.split('+').map(cityName).sort() : [])].join(' + ');
