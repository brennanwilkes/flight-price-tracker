// Starts sweep.yml runs: the hourly cron and the dashboard's "scrape everything now".
// Pattern from spirit-tracker-api tracker_schedule.ts.
import type { Env } from './types.ts';

const URL_ = 'https://api.github.com/repos/brennanwilkes/flight-price-tracker/actions/workflows/sweep.yml/dispatches';
export const MANUAL_MIN_GAP_MS = 30 * 60e3; // public endpoint: at most one manual sweep per 30 min

// One request, no retries: a failed dispatch only skips this hour. What a sweep scrapes is the
// sweep's own call (scraper/src/sweep/plan.js: the most overdue graphs first).
export async function dispatchSweep(env: Env, inputs: Record<string, string> = {}): Promise<void> {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'flight-fare-tracker',
      'content-type': 'application/json',
    },
    body: JSON.stringify(Object.keys(inputs).length ? { ref: 'main', inputs } : { ref: 'main' }),
  });
  if (res.status !== 204) throw new Error(`sweep dispatch failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

// Opening a deal alert: its gateway cities go first in the next hourly sweep (sweep.yml `focus`:
// every graph to or from them and their country's other gateways, both homes and cabins), to find
// what else the sale touched. Not a run of its own: in the one concurrency group a dispatched
// run waits behind the hour's, and a newer pending run cancels an older pending one.
export const FOCUS_HOURS = 3; // a focus not yet swept by then is dropped
const CITY = /^[A-Z]{3}$/;

export async function addFocus(env: Env, cities: unknown, now = Date.now()): Promise<{ cities: string[] }> {
  const asked = Array.isArray(cities) ? cities.filter((c): c is string => typeof c === 'string' && CITY.test(c)) : [];
  const was = await readFocus(env, now);
  const all = [...new Set([...was, ...asked])].slice(0, 8);
  if (asked.length) await env.PUSH.put('focus', JSON.stringify({ cities: all, at: new Date(now).toISOString() }));
  return { cities: all };
}

async function readFocus(env: Env, now: number): Promise<string[]> {
  const raw = await env.PUSH.get('focus');
  if (!raw) return [];
  try {
    const f = JSON.parse(raw) as { cities: string[]; at: string };
    return now - Date.parse(f.at) < FOCUS_HOURS * 3600e3 ? f.cities : [];
  } catch { return []; }
}

/** The hourly dispatch, with any focus waiting (then cleared: one sweep takes it). */
export async function hourlySweep(env: Env, now = Date.now()): Promise<void> {
  const cities = await readFocus(env, now);
  await dispatchSweep(env, cities.length ? { focus: cities.join(',') } : {});
  if (cities.length) await env.PUSH.delete('focus');
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
