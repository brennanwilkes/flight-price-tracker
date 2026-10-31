// KV-backed push health record, served by GET /health.
import type { Env, Health } from './types.ts';

const EMPTY: Health = { lastPushAt: null, lastPushStatus: null, lastError: null, lastErrorAt: null, subscribed: false };

export async function readHealth(env: Env): Promise<Health> {
  return { ...EMPTY, ...((await env.PUSH.get('health', 'json')) as Partial<Health> | null) };
}

export async function updateHealth(env: Env, patch: Partial<Health>): Promise<void> {
  await env.PUSH.put('health', JSON.stringify({ ...(await readHealth(env)), ...patch }));
}
