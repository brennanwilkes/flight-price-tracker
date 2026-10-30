#!/usr/bin/env node
/* Cloudflare account guard. Exits 0 only when wrangler, run from worker/, is authenticated
 * as the personal account. Everything else exits 1: not logged in, the Text Groove work
 * login, an unexpected whoami shape, a wrangler crash. Failing closed is the point.
 *
 * Wired in three places: npm `pre*` hooks + `npm run cf -- <args>` (package.json), and the
 * Claude Code PreToolUse hook (.claude/hooks/wrangler-guard.sh). CI does not run it: CI
 * authenticates with an API token scoped to the personal account, never a local login.
 *
 * Never "fix" a failure by changing auth from a script or an agent. Brennan re-auths with
 * `npx wrangler auth create codexwilkes` from worker/.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_EMAIL = 'brennan@codexwilkes.com';
export const EXPECTED_ACCOUNT_ID = 'a53d0d3cb40662b52e001ffd082d2f1f';

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(WORKER_DIR, 'node_modules', '.bin', 'wrangler');

function fail(msg) {
  console.error(`cf-guard: REFUSING. ${msg}`);
  console.error(`cf-guard: wrangler must be logged in as ${EXPECTED_EMAIL} (account ${EXPECTED_ACCOUNT_ID}).`);
  console.error('cf-guard: Brennan re-auths with `npx wrangler auth create codexwilkes` from worker/. Agents must not change auth.');
  process.exit(1);
}

// An env token silently overrides the profile, and token whoami may not report an email,
// so a locally exported token is refused outright. CI never runs this script.
for (const v of ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL']) {
  if (process.env[v]) fail(`${v} is set in the environment; unset it so the bound profile is used.`);
}

let raw;
try {
  raw = execFileSync(WRANGLER, ['whoami', '--json'], {
    cwd: WORKER_DIR,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  fail(`\`wrangler whoami --json\` failed (not logged in?): ${String(e.stderr || e.message).trim().split('\n').pop()}`);
}

let who;
try {
  who = JSON.parse(raw.slice(raw.indexOf('{')));
} catch {
  fail(`could not parse whoami output: ${raw.slice(0, 200)}`);
}

const email = who.email ?? who.user?.email;
const accounts = who.accounts ?? who.memberships?.map((m) => m.account) ?? [];
const accountIds = accounts.map((a) => a?.id).filter(Boolean);

if (email !== EXPECTED_EMAIL) fail(`logged in as ${JSON.stringify(email)}, keys seen: ${Object.keys(who).join(',')}.`);
if (!accountIds.includes(EXPECTED_ACCOUNT_ID)) fail(`account ${EXPECTED_ACCOUNT_ID} not among ${JSON.stringify(accountIds)}.`);

console.error(`cf-guard: ok (${email}, account ${EXPECTED_ACCOUNT_ID})`);
