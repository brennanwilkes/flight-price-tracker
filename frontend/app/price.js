/* "About the same price", everywhere it's asked (SCOPE): within 2% in business, 5% in economy.
 * Takes a class ('hybrid' | 'economy'), a cabin ('J' | 'Y'), or a trip (business if any ticket is). */
const SAME = { J: 0.02, Y: 0.05 };

function samePrice(x) {
  const biz = x === 'hybrid' || x === 'J' || (typeof x === 'object' && (x.cabin === 'J' || x.cls === 'hybrid' || x.tickets?.some((t) => t.cabin === 'J')));
  return biz ? SAME.J : SAME.Y;
}

export { samePrice };
