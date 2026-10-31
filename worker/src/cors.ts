// CORS for the Pages PWA and local dev. Reflects the Origin only when it is allowed.

const PAGES_ORIGIN = 'https://brennanwilkes.github.io';

function allowed(origin: string | null): origin is string {
  return origin !== null && (origin === PAGES_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin');
  if (!allowed(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
