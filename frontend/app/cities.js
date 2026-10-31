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

export const cityName = (code) => CITIES[code]?.name ?? code;
