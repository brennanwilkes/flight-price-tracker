// Cron handler: dispatch sweep.yml. Pattern from spirit-tracker-api tracker_schedule.ts.
import type { Env } from './types.ts';

const URL_ = 'https://api.github.com/repos/brennanwilkes/flight-price-tracker/actions/workflows/sweep.yml/dispatches';

// One request, no retries: a failed dispatch only skips this hour.
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
