#!/usr/bin/env node
/* Generate a VAPID keypair. Prints the public key (65-byte uncompressed P-256 point,
 * base64url: goes in wrangler.toml [vars] VAPID_PUBLIC_KEY). The private key (JWK `d`,
 * base64url, no trailing newline) is written to the file path given as the argument,
 * mode 0600, never to stdout. Usage: node scripts/gen-vapid.mjs <private-key-file>
 */
import { writeFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const out = process.argv[2];
if (!out) { console.error('usage: node scripts/gen-vapid.mjs <private-key-file>'); process.exit(1); }

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
writeFileSync(out, d, { mode: 0o600, flag: 'wx' }); // wx: never overwrite an existing key

console.log(`public key: ${pub}`);
console.log(`private key written to ${out} (no newline; push with: printf '%s' "$(cat ${out})" | npm run cf -- secret put VAPID_PRIVATE_KEY)`);
