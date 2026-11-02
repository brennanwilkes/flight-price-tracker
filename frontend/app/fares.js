/* The fare bundle (derived/fares.json, scraper/src/trips/fares.js bundleOf) as the lookups the
 * builder takes (build.js buildTrips), for builds in the page.
 */
export function faresOf(bundle) {
  const base = Date.parse(`${bundle.base}T00:00:00Z`);
  const iso = (day) => new Date(base + day * 864e5).toISOString().slice(0, 10);
  const ow = new Map(), rt = new Map();
  for (const [k, a] of Object.entries(bundle.ow)) {
    const [from, to, cabin] = k.split('-');
    for (let i = 0; i < a.length; i += 2) ow.set(`${from}|${to}|${cabin}|${iso(a[i])}`, a[i + 1]);
  }
  for (const [k, a] of Object.entries(bundle.rt)) {
    const [from, to, cabin] = k.split('-');
    for (let i = 0; i < a.length; i += 3) {
      const key = `${from}|${to}|${cabin}|${iso(a[i])}`;
      if (!rt.has(key)) rt.set(key, []);
      rt.get(key).push({ ret: iso(a[i + 1]), price: a[i + 2] });
    }
  }
  return {
    homes: bundle.homes,
    cities: bundle.cities,
    pacific: bundle.pacific ?? [],
    anchors: bundle.anchors,
    departures: bundle.departures,
    tiers: bundle.tiers,
    roundTrip: (from, to, cabin, out) => rt.get(`${from}|${to}|${cabin}|${out}`) ?? [],
    oneWay: (from, to, cabin, date) => ow.get(`${from}|${to}|${cabin}|${date}`) ?? null,
    asiaRT: (from, to, date) => rt.get(`${from}|${to}|Y|${date}`) ?? [],
    hop: (from, to, date) => ow.get(`${from}|${to}|Y|${date}`) ?? null,
  };
}
