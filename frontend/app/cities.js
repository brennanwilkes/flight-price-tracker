// City codes as the builder uses them → display name and map position (lon, lat).
export const CITIES = {
  YVR: { name: 'Vancouver' },
  YYJ: { name: 'Victoria' },
  DAD: { name: 'Da Nang', lon: 108.2, lat: 16.05 },
  ICN: { name: 'Seoul', lon: 126.45, lat: 37.46 },
  TPE: { name: 'Taipei', lon: 121.23, lat: 25.08 },
  HKG: { name: 'Hong Kong', lon: 113.92, lat: 22.31 },
  TYO: { name: 'Tokyo', lon: 139.78, lat: 35.55 },
  MNL: { name: 'Manila', lon: 121.02, lat: 14.51 },
  SIN: { name: 'Singapore', lon: 103.99, lat: 1.36 },
  HAN: { name: 'Hanoi', lon: 105.8, lat: 21.22 },
  SGN: { name: 'Saigon', lon: 106.66, lat: 10.82 },
  BKK: { name: 'Bangkok', lon: 100.75, lat: 13.69 },
  KUL: { name: 'Kuala Lumpur', lon: 101.71, lat: 2.74 },
};

// Airports flights connect through (the map draws them as stops). Destinations' own airports are
// the CITIES entries above, except Tokyo's two.
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
};

/** Name and map position for a city or airport code (no position: home, or off the map). */
export const place = (code) => CITIES[code] ?? AIRPORTS[code] ?? { name: code };
export const cityName = (code) => place(code).name;
