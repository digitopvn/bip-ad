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

/**
 * Keys for PII at rest (payout beneficiary details).
 * - current: PII_ENCRYPTION_KEY. Every new value is sealed with it; absent means no new writes.
 * - previous: PII_ENCRYPTION_KEY_PREVIOUS, kept only while values sealed with it remain during a rotation.
 * - legacy: SESSION_SECRET, which sealed the original v1 values. Used for decryption only.
 */
export interface PiiKeyring {
  current?: string;
  previous?: string;
  legacy?: string;
}

/** Shortest accepted PII_ENCRYPTION_KEY, in characters (e.g. `openssl rand -base64 32` gives 44). */
export const MIN_PII_KEY_LENGTH = 32;

async function aesKey(label: string, secret: string) {
  const material = await crypto.subtle.digest('SHA-256', enc.encode(`${label}:${secret}`));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Key id: a short fingerprint of the key, so a sealed value names the key that opens it without revealing it. */
export async function piiKeyId(key: string): Promise<string> {
  return (await sha256Hex(`bip.ad/pii/kid:${key}`)).slice(0, 12);
}

/** Whether `encryptField` can seal new values with this keyring. */
export const canSealPii = (keys: PiiKeyring) => (keys.current?.length ?? 0) >= MIN_PII_KEY_LENGTH;

const fromB64Url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));

/**
 * AES-GCM encryption with the current PII key. Output: v2.<kid>.<iv>.<ciphertext> (base64url).
 * The "v2.<kid>" prefix is bound as additional data, so a value cannot be relabelled to another key.
 */
export async function encryptField(keys: PiiKeyring, plain: string): Promise<string> {
  if (!keys.current || !canSealPii(keys)) throw new Error(`PII_ENCRYPTION_KEY is not configured (at least ${MIN_PII_KEY_LENGTH} characters)`);
  const kid = await piiKeyId(keys.current);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`v2.${kid}`) }, await aesKey('bip.ad/pii/v2', keys.current), enc.encode(plain));
  return `v2.${kid}.${toBase64Url(iv)}.${toBase64Url(ct)}`;
}

/** Opens v2 values with the key whose id they carry, and original v1 values with the legacy secret. */
export async function decryptField(keys: PiiKeyring, sealed: string): Promise<string> {
  const parts = sealed.split('.');
  if (parts[0] === 'v1' && parts.length === 3 && parts[1] && parts[2]) {
    if (!keys.legacy) throw new Error('v1 sealed field needs the legacy secret');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64Url(parts[1]) }, await aesKey('bip.ad/pii/v1', keys.legacy), fromB64Url(parts[2]));
    return new TextDecoder().decode(pt);
  }
  if (parts[0] === 'v2' && parts.length === 4 && parts[1] && parts[2] && parts[3]) {
    const kid = parts[1];
    let key: string | undefined;
    for (const k of [keys.current, keys.previous]) if (k && (await piiKeyId(k)) === kid) key = k;
    if (!key) throw new Error(`no PII key with id ${kid} is configured`);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64Url(parts[2]), additionalData: enc.encode(`v2.${kid}`) }, await aesKey('bip.ad/pii/v2', key), fromB64Url(parts[3]));
    return new TextDecoder().decode(pt);
  }
  throw new Error('unsupported sealed field');
}
