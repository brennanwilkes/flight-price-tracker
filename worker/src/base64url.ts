// Base64url helpers (RFC 4648 §5), ported from meowmap worker/src/base64url.ts.

export function bytesToB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function b64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function jsonToB64Url(obj: unknown): string {
  return bytesToB64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

export function b64UrlToJson<T>(b64url: string): T {
  return JSON.parse(new TextDecoder().decode(b64UrlToBytes(b64url))) as T;
}
