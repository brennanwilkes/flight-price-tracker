// Starts sweep.yml runs: the hourly cron and the dashboard's "scrape everything now".
// Pattern from spirit-tracker-api tracker_schedule.ts.
import type { Env } from './types.ts';

const URL_ = 'https://api.github.com/repos/brennanwilkes/flight-price-tracker/actions/workflows/sweep.yml/dispatches';
export const MANUAL_MIN_GAP_MS = 30 * 60e3; // public endpoint: at most one manual sweep per 30 min

// One request, no retries: a failed dispatch only skips this hour. What a sweep scrapes is the
// sweep's own call (scraper/src/sweep/plan.js: the most overdue graphs first).
export async function dispatchSweep(env: Env): Promise<void> {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'flight-fare-tracker',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (res.status !== 204) throw new Error(`sweep dispatch failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

/**
 * An extra sweep on request (dashboard button, or opening a deal alert), rate-limited.
 * Returns when it started, and whether this call started it.
 */
export async function manualSweep(env: Env, now = Date.now()): Promise<{ started: boolean; at: string }> {
  const last = await env.PUSH.get('manualSweepAt');
  if (last && now - Date.parse(last) < MANUAL_MIN_GAP_MS) return { started: false, at: last };
  await dispatchSweep(env);
  const at = new Date(now).toISOString();
  await env.PUSH.put('manualSweepAt', at);
  return { started: true, at };
}
