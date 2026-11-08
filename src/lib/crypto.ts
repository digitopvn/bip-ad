import { toBase64Url } from './ids';

const enc = new TextEncoder();

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
}

export async function hmacB64Url(secret: string, data: string) {
  return toBase64Url(await hmacSha256(secret, data));
}

export async function sha256Hex(data: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(data)));
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** value.signature, signature = HMAC(secret, value). */
export async function sign(secret: string, value: string) {
  return `${value}.${await hmacB64Url(secret, value)}`;
}

export async function unsign(secret: string, signed: string): Promise<string | null> {
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const value = signed.slice(0, i);
  return safeEqual(await hmacB64Url(secret, value), signed.slice(i + 1)) ? value : null;
}

async function aesKey(secret: string) {
  const material = await crypto.subtle.digest('SHA-256', enc.encode(`bip.ad/pii/v1:${secret}`));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** AES-GCM encryption for PII at rest (payout beneficiary details). Output: v1.<iv>.<ciphertext> base64url. */
export async function encryptField(secret: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(plain));
  return `v1.${toBase64Url(iv)}.${toBase64Url(ct)}`;
}

const fromB64Url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));

export async function decryptField(secret: string, sealed: string): Promise<string> {
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('unsupported sealed field');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64Url(iv) }, await aesKey(secret), fromB64Url(ct));
  return new TextDecoder().decode(pt);
}
