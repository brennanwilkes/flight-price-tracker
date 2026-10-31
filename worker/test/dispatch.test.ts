// The manual sweep's rate limit (GitHub's API stubbed).
//   node --test --experimental-strip-types test/*.test.ts

import { test } from 'node:test';
import assert from 'node:assert';
import { manualSweep, MANUAL_MIN_GAP_MS } from '../src/dispatch.ts';
import type { Env } from '../src/types.ts';

test('manual sweep: dispatches, then refuses for 30 min', async () => {
  const kv = new Map<string, string>();
  const env = { PUSH: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } }, GH_DISPATCH_TOKEN: 't' } as unknown as Env;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }) as typeof fetch;

  const t0 = Date.parse('2027-01-01T00:00:00Z');
  assert.strictEqual((await manualSweep(env, t0)).started, true);
  assert.strictEqual((await manualSweep(env, t0 + MANUAL_MIN_GAP_MS - 1)).started, false);
  assert.strictEqual((await manualSweep(env, t0 + MANUAL_MIN_GAP_MS)).started, true);
  assert.deepStrictEqual(bodies, [{ ref: 'main' }, { ref: 'main' }]);
});
