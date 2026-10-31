// Flight fare tracker Worker: push subscription store + Web Push sender + hourly sweep clock.
import type { Env } from './types.ts';
import { corsHeaders } from './cors.ts';
import { dispatchSweep } from './dispatch.ts';
import { readHealth, updateHealth } from './health.ts';
import { sendPush, type PushMessage, type PushSubscriptionJson } from './push.ts';

const VAPID_SUBJECT = 'mailto:brennan@codexwilkes.com';

function json(req: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(req) },
  });
}

async function readJson(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return null; }
}

function isSubscription(v: unknown): v is PushSubscriptionJson {
  const s = v as PushSubscriptionJson | null;
  return typeof s?.endpoint === 'string' && s.endpoint.startsWith('https://')
    && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string';
}

async function subscribe(req: Request, env: Env): Promise<Response> {
  const sub = await readJson(req);
  if (!isSubscription(sub)) return json(req, { error: 'invalid subscription' }, 400);
  // Keep only what sending needs. The one subscription replaces any previous one.
  await env.PUSH.put('subscription', JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }));
  await updateHealth(env, { subscribed: true });
  return json(req, { ok: true });
}

// Constant-time-ish compare via equal-length check then XOR; the secret is long and random.
function authorized(req: Request, env: Env): boolean {
  const given = req.headers.get('Authorization') ?? '';
  const want = `Bearer ${env.NOTIFY_SECRET}`;
  if (!env.NOTIFY_SECRET || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

async function notify(req: Request, env: Env): Promise<Response> {
  if (!authorized(req, env)) return json(req, { error: 'unauthorized' }, 401);
  const b = await readJson(req) as Partial<PushMessage> | null;
  if (typeof b?.title !== 'string' || typeof b.body !== 'string') return json(req, { error: 'title and body required' }, 400);
  const message: PushMessage = {
    title: b.title, body: b.body,
    url: typeof b.url === 'string' ? b.url : '',
    tag: typeof b.tag === 'string' ? b.tag : 'fare',
  };

  const sub = await env.PUSH.get('subscription', 'json') as PushSubscriptionJson | null;
  if (sub === null) return json(req, { ok: false, error: 'no subscription' }, 409);

  const now = new Date().toISOString();
  try {
    const res = await sendPush(sub, message,
      { publicKey: env.VAPID_PUBLIC_KEY, privateD: env.VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT }, Math.floor(Date.now() / 1000));
    if (res.ok) {
      await updateHealth(env, { lastPushAt: now, lastPushStatus: res.status });
      return json(req, { ok: true, status: res.status });
    }
    // Apple names the reason in the body ("BadJwtToken", "BadDeviceToken").
    const detail = (await res.text()).slice(0, 300);
    const gone = res.status === 404 || res.status === 410;
    if (gone) await env.PUSH.delete('subscription');
    await updateHealth(env, {
      lastPushStatus: res.status, lastError: `HTTP ${res.status} ${detail}`.trim(), lastErrorAt: now,
      ...(gone ? { subscribed: false } : {}),
    });
    return json(req, { ok: false, status: res.status, removed: gone }, 502);
  } catch (e) {
    await updateHealth(env, { lastError: `send threw: ${String(e)}`, lastErrorAt: now });
    return json(req, { ok: false, error: 'send failed' }, 502);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (req.method === 'POST' && pathname === '/subscribe') return subscribe(req, env);
    if (req.method === 'POST' && pathname === '/notify') return notify(req, env);
    if (req.method === 'GET' && pathname === '/health') return json(req, await readHealth(env));
    if (req.method === 'GET' && pathname === '/vapid') return json(req, { publicKey: env.VAPID_PUBLIC_KEY });
    return json(req, { error: 'not found' }, 404);
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await dispatchSweep(env);
  },
};
