import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, piiKeyId } from '../src/lib/crypto';
import { toBase64Url } from '../src/lib/ids';
import { piiKeys, requestPayout } from '../src/domain/wallet';
import { E, db, makeUser, realCfg } from './helpers';

const enc = new TextEncoder();
const KEY_A = 'pii-key-a-0123456789abcdef0123456789abcdef';
const KEY_B = 'pii-key-b-0123456789abcdef0123456789abcdef';
const LEGACY = 'legacy-session-secret-0123456789abcdef';

/** A v1 value exactly as the original scheme stored it: AES-GCM keyed by SHA-256("bip.ad/pii/v1:" + SESSION_SECRET). */
async function sealV1(secret: string, plain: string) {
  const material = await crypto.subtle.digest('SHA-256', enc.encode(`bip.ad/pii/v1:${secret}`));
  const key = await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

describe('PII field encryption', () => {
  it('existing v1 values still decrypt with the legacy session secret', async () => {
    const v1 = await sealV1(LEGACY, 'VCB 0123456789 NGUYEN A');
    expect(await decryptField({ current: KEY_A, legacy: LEGACY }, v1)).toBe('VCB 0123456789 NGUYEN A');
    await expect(decryptField({ current: KEY_A }, v1)).rejects.toThrow(/legacy/);
    await expect(decryptField({ current: KEY_A, legacy: 'another-secret-0123456789abcdef' }, v1)).rejects.toThrow();
  });

  it('new values use the v2 envelope with the key id and decrypt only with that key', async () => {
    const sealed = await encryptField({ current: KEY_A, legacy: LEGACY }, 'payee@paypal.test');
    const [v, kid, iv, ct, ...rest] = sealed.split('.');
    expect(v).toBe('v2');
    expect(kid).toBe(await piiKeyId(KEY_A));
    expect(iv && ct).toBeTruthy();
    expect(rest).toEqual([]);
    expect(sealed).not.toContain('payee');
    expect(await decryptField({ current: KEY_A }, sealed)).toBe('payee@paypal.test');
    // The legacy secret never opens v2 values; a different key is rejected by its id.
    await expect(decryptField({ current: KEY_B, legacy: KEY_A }, sealed)).rejects.toThrow(/no PII key/);
    // The key id is authenticated: relabelling the value to another key fails.
    const relabelled = ['v2', await piiKeyId(KEY_B), iv, ct].join('.');
    await expect(decryptField({ current: KEY_B }, relabelled)).rejects.toThrow();
    await expect(decryptField({ current: KEY_A }, 'v3.x.y.z')).rejects.toThrow(/unsupported/);
  });

  it('after a rotation, values sealed with the previous key still open and new ones use the new key', async () => {
    const old = await encryptField({ current: KEY_A }, 'old ref');
    const rotated = { current: KEY_B, previous: KEY_A, legacy: LEGACY };
    expect(await decryptField(rotated, old)).toBe('old ref');
    const fresh = await encryptField(rotated, 'new ref');
    expect(fresh.split('.')[1]).toBe(await piiKeyId(KEY_B));
    expect(await decryptField({ current: KEY_B }, fresh)).toBe('new ref');
  });

  it('refuses to seal without a PII key instead of falling back to the session secret', async () => {
    await expect(encryptField({ legacy: LEGACY }, 'x')).rejects.toThrow(/PII_ENCRYPTION_KEY/);
    await expect(encryptField({ current: 'short', legacy: LEGACY }, 'x')).rejects.toThrow(/PII_ENCRYPTION_KEY/);
    expect(piiKeys({ ...E, PII_ENCRYPTION_KEY: '' })).toMatchObject({ current: undefined, legacy: E.SESSION_SECRET });
  });

  it('a payout request fails with a clear error while PII_ENCRYPTION_KEY is missing', async () => {
    const u = await makeUser();
    const req = { currency: 'USD' as const, amountMinor: 500, payoutMethod: 'paypal' as const, beneficiaryReference: 'me@paypal.test', idempotencyKey: 'pii-missing' };
    await expect(requestPayout(db(), realCfg(), piiKeys({ ...E, PII_ENCRYPTION_KEY: undefined }), u, req))
      .rejects.toMatchObject({ code: 'payouts_unavailable', status: 503, message: expect.stringContaining('PII_ENCRYPTION_KEY') });
    const n = await db().prepare('SELECT COUNT(*) AS n FROM payout_requests WHERE user_id = ?').bind(u).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});
