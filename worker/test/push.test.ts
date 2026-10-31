// Web Push encryption and VAPID (ported from meowmap). Hand-rolled crypto with no dependency is only
// defensible if it is pinned to the spec's own numbers, so the encryption test is the RFC
// 8291 §5 example (inputs from Appendix A) byte for byte: a single wrong label or byte order there produces a
// notification the phone silently drops, with nothing in any log.
//   node --test --experimental-strip-types test/*.test.ts

import { test } from 'node:test';
import assert from 'node:assert';
import { encryptPayload, vapidAuthorization } from '../src/push.ts';
import { b64UrlToBytes, b64UrlToJson, bytesToB64Url } from '../src/base64url.ts';

const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  // §5, the complete encrypted body (header + ciphertext), copied from the raw RFC text.
  message: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** A P-256 private key from its scalar plus the public point it belongs to. */
async function importPrivate(d: string, publicKey: string, alg: 'ECDH' | 'ECDSA'): Promise<CryptoKey> {
  const pub = b64UrlToBytes(publicKey);
  return await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d, x: bytesToB64Url(pub.slice(1, 33)), y: bytesToB64Url(pub.slice(33, 65)) },
    { name: alg, namedCurve: 'P-256' },
    false,
    alg === 'ECDH' ? ['deriveBits'] : ['sign'],
  );
}

test('encryption reproduces the RFC 8291 example exactly', async () => {
  const out = await encryptPayload(
    b64UrlToBytes(RFC.plaintext),
    b64UrlToBytes(RFC.uaPublic),
    b64UrlToBytes(RFC.auth),
    b64UrlToBytes(RFC.salt),
    await importPrivate(RFC.asPrivate, RFC.asPublic, 'ECDH'),
    b64UrlToBytes(RFC.asPublic),
  );
  assert.strictEqual(bytesToB64Url(out), RFC.message);
});

test('an oversized payload throws instead of being split or truncated', async () => {
  await assert.rejects(encryptPayload(
    new Uint8Array(5000),
    b64UrlToBytes(RFC.uaPublic), b64UrlToBytes(RFC.auth), b64UrlToBytes(RFC.salt),
    await importPrivate(RFC.asPrivate, RFC.asPublic, 'ECDH'), b64UrlToBytes(RFC.asPublic),
  ));
});

test('the VAPID header is an ES256 JWT for the push service origin, verifiable with k', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = bytesToB64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer));
  const d = (await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey).d as string;
  const nowS = 1_790_000_000;

  const value = await vapidAuthorization('https://web.push.apple.com/QGuQyavXutnMH', publicKey, d, 'mailto:brennan@codexwilkes.com', nowS);
  const m = value.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.notStrictEqual(m, null, value);
  const [, h, c, sig, k] = m as RegExpMatchArray;

  assert.strictEqual(k, publicKey);
  assert.deepStrictEqual(b64UrlToJson(h), { typ: 'JWT', alg: 'ES256' });
  const claims = b64UrlToJson<{ aud: string; exp: number; sub: string }>(c);
  // The origin only. A path in `aud` is rejected by every push service.
  assert.strictEqual(claims.aud, 'https://web.push.apple.com');
  assert.ok(claims.exp > nowS && claims.exp <= nowS + 86_400, 'exp must be within 24h');
  assert.match(claims.sub, /^(https:|mailto:)/);

  const verifyKey = await crypto.subtle.importKey('raw', b64UrlToBytes(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, verifyKey, b64UrlToBytes(sig), new TextEncoder().encode(`${h}.${c}`),
  );
  assert.ok(ok, 'signature must verify against k');
  assert.strictEqual(b64UrlToBytes(sig).length, 64, 'JWS ES256 is raw r||s, not DER');
});

test('sendPush POSTs an aes128gcm body with VAPID auth and a tag-derived Topic', async () => {
  const { sendPush } = await import('../src/push.ts');
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = bytesToB64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer));
  const d = (await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey).d as string;

  let seen: { url: string; init: RequestInit } | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(null, { status: 201 }); }) as typeof fetch;
  try {
    const res = await sendPush(
      { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: RFC.uaPublic, auth: RFC.auth } },
      { title: 't', body: 'b', url: '#/deal/1', tag: 'YVR-ICN business!' },
      { publicKey, privateD: d, subject: 'mailto:brennan@codexwilkes.com' }, 1_790_000_000,
    );
    assert.strictEqual(res.status, 201);
  } finally { globalThis.fetch = realFetch; }

  const s = seen as unknown as { url: string; init: RequestInit };
  const h = s.init.headers as Record<string, string>;
  assert.strictEqual(s.url, 'https://web.push.apple.com/abc');
  assert.strictEqual(h['Content-Encoding'], 'aes128gcm');
  assert.strictEqual(h['Topic'], 'YVR-ICNbusiness');
  assert.match(h['Authorization'], /^vapid t=.+, k=/);
  assert.ok((s.init.body as Uint8Array).length > 86);
});
