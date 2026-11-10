import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { beginCheckout, getIntent, quote } from '../src/domain/bidding';
import { config } from '../src/domain/config';
import { newId } from '../src/lib/ids';
import { E, db, makeProduct, makeUser } from './helpers';

const BASE = 'https://bip.test';
const sandboxEnv = { ...E, PAYMENT_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_API_BASE: 'https://paypal.test' };

async function signedIn(userId: string) {
  const sid = newId('sid');
  await E.OAUTH_KV.put(`session:${sid}`, JSON.stringify({ userId, csrf: newId('csrf') }));
  return { cookie: `bip_session=${sid}` };
}

/** A USD PayPal checkout awaiting payment for 1234 rank units ($12.34). */
async function openCheckout() {
  const owner = await makeUser('Owner');
  const name = `Private ${newId('x')}`;
  const p = await makeProduct(owner, name);
  const { intent } = await quote(db(), config(E), owner, { productId: p, board: 'weekly', rankUnits: 1234, currency: 'USD', idempotencyKey: newId('q') });
  await beginCheckout(db(), config(E), owner, intent.id, 'paypal');
  return { owner, name, intent: (await getIntent(db(), intent.id))! };
}

afterEach(() => vi.restoreAllMocks());

describe('checkout privacy', () => {
  it('shows the quote and pay buttons only to the signed-in owner', async () => {
    const { owner, name, intent } = await openCheckout();
    const url = `${BASE}/checkout/${intent.id}`;
    const amount = '12.34';
    const signIn = `href="/login?next=${encodeURIComponent(`/checkout/${intent.id}`)}"`;

    const ownerPage = await (await app.request(url, { headers: await signedIn(owner) }, E)).text();
    expect(ownerPage).toContain(amount);
    expect(ownerPage).toContain('Due now');
    expect(ownerPage).toContain(`action="/checkout/${intent.id}/pay"`);

    const stranger = await makeUser('Stranger');
    for (const headers of [{}, await signedIn(stranger)]) {
      const r = await app.request(url, { headers }, E);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain(name);
      expect(html).toContain('Sign in as the owner to view and pay.');
      expect(html).toContain(signIn);
      for (const hidden of [amount, '1,234', 'Due now', 'Wallet applied', 'Projected rank', '/pay"', 'name="csrf"']) expect(html).not.toContain(hidden);
    }
  });

  it('PayPal return and capture send anyone but the owner to sign in, without calling PayPal', async () => {
    const { owner, intent } = await openCheckout();
    const orderId = `ORDER-${intent.id}`;
    await db().prepare('UPDATE bid_intents SET provider_order_id = ? WHERE id = ?').bind(orderId, intent.id).run();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const base = `${BASE}/checkout/${intent.id}`;
    const login = `/login?next=${encodeURIComponent(`/checkout/${intent.id}/paypal-return?token=${orderId}`)}`;
    const stranger = await signedIn(await makeUser('Stranger'));

    for (const headers of [{}, stranger]) {
      const get = await app.request(`${base}/paypal-return?token=${orderId}`, { redirect: 'manual', headers }, sandboxEnv);
      expect(get.status).toBe(303);
      expect(get.headers.get('location')).toBe(login);
      const post = await app.request(`${base}/paypal-capture`, { method: 'POST', body: new URLSearchParams({ token: orderId }), headers }, sandboxEnv);
      expect(post.status).toBe(303);
      expect(post.headers.get('location')).toBe(login);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getIntent(db(), intent.id))!.status).toBe('awaiting_payment');

    // The owner gets the confirmation page whose POST captures.
    const mine = await app.request(`${base}/paypal-return?token=${orderId}`, { headers: await signedIn(owner) }, sandboxEnv);
    expect(mine.status).toBe(200);
    expect(await mine.text()).toContain(`action="/checkout/${intent.id}/paypal-capture"`);
  });
});
