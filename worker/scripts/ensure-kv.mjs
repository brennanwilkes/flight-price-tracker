#!/usr/bin/env node
/* CI only: create the PUSH KV namespace if it doesn't exist and patch its id over __KV_ID__ in
 * wrangler.toml (the checkout's copy; never committed). Idempotent, so it runs on every deploy.
 * Pattern from spirit-tracker-api scripts/ensure-kv-and-patch.mjs.
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/ensure-kv.mjs
 */
import fs from 'node:fs';

const TITLE = 'flight-fare-tracker-push';
const API = 'https://api.cloudflare.com/client/v4';

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env('CLOUDFLARE_API_TOKEN')}`, 'Content-Type': 'application/json' },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(`Cloudflare API ${res.status}: ${data?.errors?.[0]?.message ?? res.statusText}`);
  return data.result;
}

const base = `/accounts/${env('CLOUDFLARE_ACCOUNT_ID')}/storage/kv/namespaces`;
const find = async () => (await cf(`${base}?per_page=100`)).find((n) => n.title === TITLE);
let ns = await find();
if (!ns) {
  try {
    ns = await cf(base, { method: 'POST', body: JSON.stringify({ title: TITLE }) });
  } catch (e) {
    ns = await find(); // a concurrent deploy created it
    if (!ns) throw e;
  }
}

const toml = fs.readFileSync('wrangler.toml', 'utf8');
if (!toml.includes('"__KV_ID__"')) throw new Error('wrangler.toml has no __KV_ID__ placeholder');
fs.writeFileSync('wrangler.toml', toml.replace('"__KV_ID__"', `"${ns.id}"`));
console.log(`KV ${TITLE}: ${ns.id}`);
