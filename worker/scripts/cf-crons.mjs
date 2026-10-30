#!/usr/bin/env node
/* Read-only: list every Worker on the personal account and its cron triggers, to check
 * headroom against the free plan's 5-per-account cron limit. GET requests only.
 *
 * Wrangler has no command that lists all Workers' crons, so this uses the API with
 * wrangler's own OAuth token. The token stays inside this process: never printed,
 * logged, or written anywhere.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_ACCOUNT_ID } from './cf-guard.mjs'; // importing runs the guard; exits on failure

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(WORKER_DIR, 'node_modules', '.bin', 'wrangler');
const FREE_PLAN_CRON_LIMIT = 5;

const raw = execFileSync(WRANGLER, ['auth', 'token', '--json'], {
  cwd: WORKER_DIR,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const parsed = JSON.parse(raw.slice(raw.indexOf('{')));
const token = parsed.token ?? parsed.access_token ?? parsed.oauth_token;
if (!token) {
  console.error(`cf-crons: no token in \`wrangler auth token --json\` (keys: ${Object.keys(parsed).join(',')})`);
  process.exit(1);
}

async function get(path) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!body.success) throw new Error(`GET ${path} -> ${res.status} ${JSON.stringify(body.errors)}`);
  return body.result;
}

const base = `/accounts/${EXPECTED_ACCOUNT_ID}/workers/scripts`;
const scripts = await get(base);
let total = 0;
for (const s of scripts) {
  const { schedules = [] } = await get(`${base}/${encodeURIComponent(s.id)}/schedules`);
  total += schedules.length;
  console.log(`${s.id.padEnd(32)} ${schedules.length ? schedules.map((x) => x.cron).join(' | ') : '-'}`);
}
console.log(`\n${scripts.length} workers, ${total} cron trigger(s); free-plan limit ${FREE_PLAN_CRON_LIMIT} per account.`);
