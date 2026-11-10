import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginCheckout, getIntent, quote, refund } from '../src/domain/bidding';
import { config } from '../src/domain/config';
import { loadStandings } from '../src/domain/ranking';
import { newId } from '../src/lib/ids';
import { normalizePayPal, normalizeSePay, processEvent } from '../src/payments/process';
import { verifyWebhook } from '../src/payments/paypal';
import { app } from '../src/app';
import { assertProviderEnabled, providerEnabled } from '../src/payments/checkout';
import { checkoutView } from '../src/routes/view-data';
import type { Env } from '../src/env';
import { signCheckoutFields, verifyIpn } from '../src/payments/sepay';
import { E, db, ledgerBalancedEverywhere, makeProduct, makeUser } from './helpers';

const sandboxCfg = () => ({ ...config(E), paymentMode: 'sandbox' as const });

async function openIntent(provider: 'paypal' | 'sepay', units = 1500) {
  const u = await makeUser();
  const p = await makeProduct(u, `Pay ${provider} ${newId('x')}`);
  const { intent } = await quote(db(), config(E), u, { productId: p, board: 'weekly', rankUnits: units, currency: provider === 'paypal' ? 'USD' : 'VND', idempotencyKey: newId('q') });
  await beginCheckout(db(), config(E), u, intent.id, provider);
  return { u, p, intent: (await getIntent(db(), intent.id))! };
}

const paypalCapture = (intentId: string, captureId: string, value: string, eventId = newId('WH')) => ({
  id: eventId, event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource: { id: captureId, status: 'COMPLETED', custom_id: intentId, amount: { currency_code: 'USD', value } },
});

const contributions = async (intentId: string) => (await db().prepare('SELECT COUNT(*) AS n FROM bid_contributions WHERE bid_intent_id = ?').bind(intentId).first<{ n: number }>())!.n;
const activeUnits = async (p: string) => (await loadStandings(db(), 'weekly', Date.now() + 1000)).find(r => r.productId === p)?.activeRankUnits ?? 0;

afterEach(() => vi.restoreAllMocks());

describe('PayPal', () => {
  it('A05: the same capture delivered twice (same event, and a different event id) → exactly one contribution and one allocation', async () => {
    const { p, intent } = await openIntent('paypal');
    const ev = normalizePayPal(paypalCapture(intent.id, 'CAP-1-' + intent.id, '15.00'));
    expect((await processEvent(db(), sandboxCfg(), ev)).status).toBe('settled');
    expect((await processEvent(db(), sandboxCfg(), ev)).status).toBe('replayed');
    expect((await processEvent(db(), sandboxCfg(), normalizePayPal(paypalCapture(intent.id, 'CAP-1-' + intent.id, '15.00')))).status).toBe('duplicate');
    expect(await contributions(intent.id)).toBe(1);
    expect(await activeUnits(p)).toBe(1500);
    const txns = await db().prepare(`SELECT COUNT(*) AS n FROM ledger_transactions WHERE kind = 'bid_settlement' AND reference_id = ?`).bind(intent.id).first<{ n: number }>();
    expect(txns!.n).toBe(1);
    expect(await ledgerBalancedEverywhere()).toBe(true);
  });

  it('A06: an intent awaiting payment (redirect only, no capture) does not rank', async () => {
    const { p, intent } = await openIntent('paypal');
    expect(intent.status).toBe('awaiting_payment');
    expect(await activeUnits(p)).toBe(0);
    expect(await contributions(intent.id)).toBe(0);
  });

  it('PENDING / DENIED captures and wrong amounts never confirm a bid', async () => {
    const { intent } = await openIntent('paypal');
    const pending = normalizePayPal({ ...paypalCapture(intent.id, 'CAP-P', '15.00'), resource: { ...paypalCapture(intent.id, 'CAP-P', '15.00').resource, status: 'PENDING' } });
    expect((await processEvent(db(), sandboxCfg(), pending)).status).toBe('ignored');
    expect((await processEvent(db(), sandboxCfg(), normalizePayPal({ id: newId('WH'), event_type: 'PAYMENT.CAPTURE.DENIED', resource: { id: 'x' } }))).status).toBe('ignored');
    expect((await processEvent(db(), sandboxCfg(), normalizePayPal(paypalCapture(intent.id, 'CAP-W', '1.00')))).status).toBe('review:amount_mismatch');
    expect(await contributions(intent.id)).toBe(0);
    expect((await getIntent(db(), intent.id))!.status).toBe('needs_review');
  });

  it('A19: webhook verification goes through PayPal verify-webhook-signature; FAILURE or missing headers are rejected', async () => {
    const env = { ...E, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_WEBHOOK_ID: 'WH-ID', PAYPAL_API_BASE: 'https://paypal.test' };
    const body = JSON.stringify(paypalCapture('bid_x', 'CAP-X', '1.00'));
    const headers = new Headers({ 'paypal-transmission-id': 't1', 'paypal-transmission-sig': 'sig', 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-transmission-time': new Date().toISOString() });
    let verifyBody: Record<string, unknown> = {};
    const fetcher = (status: string) => vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'tok' });
      verifyBody = JSON.parse(String(init?.body));
      return Response.json({ verification_status: status });
    }) as unknown as typeof fetch;
    expect(await verifyWebhook(env, headers, body, fetcher('SUCCESS'))).not.toBeNull();
    expect(verifyBody.webhook_id).toBe('WH-ID');
    expect(verifyBody.transmission_sig).toBe('sig');
    expect(await verifyWebhook(env, headers, body, fetcher('FAILURE'))).toBeNull();
    expect(await verifyWebhook(env, new Headers(), body, fetcher('SUCCESS'))).toBeNull();
    expect(await verifyWebhook({ ...env, PAYPAL_WEBHOOK_ID: undefined }, headers, body, fetcher('SUCCESS'))).toBeNull();
  });

  it('A19: the event is sent to verify-webhook-signature byte for byte, not re-serialized', async () => {
    const env = { ...E, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_WEBHOOK_ID: 'WH-ID', PAYPAL_API_BASE: 'https://paypal.test' };
    // Spacing, key order and a number form that JSON.stringify would rewrite.
    const raw = '{ "resource": {"id":"CAP-RAW", "amount": {"value": "1.00", "fee": 1.50}}, "id" : "WH-RAW",\n "event_type":"PAYMENT.CAPTURE.COMPLETED", "n": 1e2 }';
    const headers = new Headers({ 'paypal-transmission-id': 't1', 'paypal-transmission-sig': 'sig', 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-transmission-time': '2026-11-09T00:00:00Z' });
    let sent = '';
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'tok' });
      sent = String(init?.body);
      return Response.json({ verification_status: 'SUCCESS' });
    }) as unknown as typeof fetch;
    expect((await verifyWebhook(env, headers, raw, fetcher))?.id).toBe('WH-RAW');
    expect(sent.endsWith(`,"webhook_event":${raw}}`)).toBe(true);
    const parsed = JSON.parse(sent);
    expect(parsed.webhook_id).toBe('WH-ID');
    expect(parsed.webhook_event.id).toBe('WH-RAW');
  });

  it('a provider is offered and accepted only once its secrets are set (simulated mode offers all)', async () => {
    const sandbox = { ...E, PAYMENT_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_WEBHOOK_ID: 'WH', SEPAY_MERCHANT_ID: undefined, SEPAY_SECRET_KEY: undefined, SEPAY_IPN_SECRET: undefined } as Env;
    const sc = config(sandbox);
    expect(providerEnabled(sandbox, sc, 'paypal')).toBe(true);
    expect(providerEnabled(sandbox, sc, 'sepay')).toBe(false);
    expect(providerEnabled({ ...sandbox, PAYPAL_WEBHOOK_ID: undefined }, sc, 'paypal')).toBe(false);
    expect(providerEnabled(E, config(E), 'sepay')).toBe(true);
    expect(() => assertProviderEnabled(sandbox, sc, 'sepay')).toThrow(/not available/);
    expect(() => assertProviderEnabled(sandbox, sc, 'wallet')).not.toThrow();
    const { intent } = await openIntent('sepay');
    expect((await checkoutView(sandbox, intent, true, 'csrf', null)).providers).toEqual([]);
    expect((await checkoutView(E, intent, true, 'csrf', null)).providers).toEqual(['sepay']);
  });

  it('PayPal return GET has no side effects; only the POST it renders captures and settles', async () => {
    const { u, p, intent } = await openIntent('paypal');
    const sid = newId('sid');
    await E.OAUTH_KV.put(`session:${sid}`, JSON.stringify({ userId: u, csrf: newId('csrf') }));
    const owner = { cookie: `bip_session=${sid}` };
    const orderId = `ORDER-${intent.id}`;
    await db().prepare('UPDATE bid_intents SET provider_order_id = ? WHERE id = ?').bind(orderId, intent.id).run();
    const sandboxEnv = { ...E, PAYMENT_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_API_BASE: 'https://paypal.test' };
    const calls: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'tok' });
      return Response.json({ status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: `CAP-RET-${intent.id}`, status: 'COMPLETED', custom_id: intent.id, amount: { currency_code: 'USD', value: '15.00' } }] } }] });
    });
    try {
      const base = `https://bip.test/checkout/${intent.id}`;
      const get = await app.request(`${base}/paypal-return?token=${orderId}`, { headers: owner }, sandboxEnv);
      expect(get.status).toBe(200);
      const page = await get.text();
      expect(page).toContain(`action="/checkout/${intent.id}/paypal-capture"`);
      expect(page).toContain(`value="${orderId}"`);
      expect(calls).toEqual([]);
      expect(await contributions(intent.id)).toBe(0);

      const post = (token: string) => app.request(`${base}/paypal-capture`, { method: 'POST', body: new URLSearchParams({ token }), headers: owner }, sandboxEnv);
      const bad = await post('ORDER-other');
      expect(bad.headers.get('location')).toBe(`/checkout/${intent.id}?r=error`);
      expect(calls).toEqual([]);

      const ok = await post(orderId);
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')).toBe(`/checkout/${intent.id}?r=paid`);
      expect(calls.some(u => u.endsWith(`/v2/checkout/orders/${orderId}/capture`))).toBe(true);
      expect(await contributions(intent.id)).toBe(1);
      expect(await activeUnits(p)).toBe(1500);

      // Once settled, following the return link again just shows the checkout.
      const again = await app.request(`${base}/paypal-return?token=${orderId}`, { redirect: 'manual', headers: owner }, sandboxEnv);
      expect(again.headers.get('location')).toBe(`/checkout/${intent.id}`);
    } finally {
      spy.mockRestore();
    }
  });

  it('A07: refund after the bid is active voids the contribution with a corrective posting; a replayed refund is a no-op', async () => {
    const { p, intent } = await openIntent('paypal');
    await processEvent(db(), sandboxCfg(), normalizePayPal(paypalCapture(intent.id, 'CAP-R-' + intent.id, '15.00')));
    expect(await activeUnits(p)).toBe(1500);
    const refundEv = normalizePayPal({ id: newId('WH'), event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REF-1', links: [{ rel: 'up', href: `https://api.paypal.com/v2/payments/captures/CAP-R-${intent.id}` }] } });
    expect((await processEvent(db(), sandboxCfg(), refundEv)).status).toBe('refunded');
    expect(await activeUnits(p)).toBe(0);
    expect((await refund(db(), { provider: 'paypal', providerPaymentId: `CAP-R-${intent.id}`, kind: 'refund', atMs: Date.now() })).status).toBe('duplicate');
    const ctb = await db().prepare('SELECT status FROM bid_contributions WHERE bid_intent_id = ?').bind(intent.id).first<{ status: string }>();
    expect(ctb!.status).toBe('voided_after_refund');
    // The original settlement is still there (history is not edited); a separate refund transaction offsets it.
    const kinds = await db().prepare(`SELECT kind FROM ledger_transactions WHERE reference_id IN (?, (SELECT id FROM payments WHERE bid_intent_id = ?)) ORDER BY kind`).bind(intent.id, intent.id).all<{ kind: string }>();
    expect(kinds.results.map(k => k.kind)).toEqual(['bid_refund', 'bid_settlement']);
    const cash = await db().prepare(`SELECT SUM(amount_minor) AS s FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.txn_id WHERE e.account = 'asset:cash:paypal' AND t.reference_id IN (?, (SELECT id FROM payments WHERE bid_intent_id = ?))`).bind(intent.id, intent.id).first<{ s: number }>();
    expect(cash!.s).toBe(0);
    expect(await ledgerBalancedEverywhere()).toBe(true);
  });

  it('webhook endpoint rejects unsigned PayPal calls before touching the ledger (A19)', async () => {
    const before = (await db().prepare('SELECT COUNT(*) AS n FROM ledger_transactions').first<{ n: number }>())!.n;
    const { SELF } = await import('cloudflare:test');
    const r = await SELF.fetch('https://bip.test/api/webhooks/paypal', { method: 'POST', body: JSON.stringify(paypalCapture('bid_x', 'CAP-F', '1.00')), headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(401);
    const after = (await db().prepare('SELECT COUNT(*) AS n FROM ledger_transactions').first<{ n: number }>())!.n;
    expect(after).toBe(before);
  });
});

describe('SePay Payment Gateway', () => {
  const ipn = (intentId: string, txId: string, amount: number, type = 'ORDER_PAID') => ({
    timestamp: 1790000000, notification_type: type,
    order: { id: 'o1', order_id: 'o1', order_status: 'CAPTURED', order_currency: 'VND', order_amount: String(amount), order_invoice_number: intentId },
    transaction: { id: 't1', transaction_id: txId, transaction_status: 'APPROVED', transaction_amount: String(amount), transaction_currency: 'VND' },
  });

  it('A19: IPN without the configured X-Secret-Key is rejected; correct key accepted', () => {
    const env = { ...E, SEPAY_IPN_SECRET: 'ipn-secret-123' };
    const body = JSON.stringify(ipn('bid_x', 'TX1', 1000));
    expect(verifyIpn(env, new Headers({ 'x-secret-key': 'wrong' }), body)).toBeNull();
    expect(verifyIpn(env, new Headers(), body)).toBeNull();
    expect(verifyIpn({ ...env, SEPAY_IPN_SECRET: undefined }, new Headers({ 'x-secret-key': 'ipn-secret-123' }), body)).toBeNull();
    expect(verifyIpn(env, new Headers({ 'x-secret-key': 'ipn-secret-123' }), body)).not.toBeNull();
  });

  it('VND quote → verified IPN → exactly one contribution; duplicate IPN for the same transaction ignored (A05)', async () => {
    const { p, intent } = await openIntent('sepay', 1000);
    expect(intent.quote_currency).toBe('VND');
    expect(intent.quote_minor).toBe(Math.ceil(1000 * 25400 / 100));
    const ev = normalizeSePay(ipn(intent.id, 'TX-' + intent.id, intent.quote_minor));
    expect((await processEvent(db(), sandboxCfg(), ev)).status).toBe('settled');
    expect((await processEvent(db(), sandboxCfg(), ev)).status).toBe('replayed');
    expect(await contributions(intent.id)).toBe(1);
    expect(await activeUnits(p)).toBe(1000); // rank units are the USD-equivalent locked in the quote
    // TRANSACTION_VOID reverses it.
    expect((await processEvent(db(), sandboxCfg(), normalizeSePay(ipn(intent.id, 'TX-' + intent.id, intent.quote_minor, 'TRANSACTION_VOID')))).status).toBe('refunded');
    expect(await activeUnits(p)).toBe(0);
    expect(await ledgerBalancedEverywhere()).toBe(true);
  });

  it('an IPN for a PayPal intent cannot settle it (provider binding)', async () => {
    const { intent } = await openIntent('paypal');
    expect((await processEvent(db(), sandboxCfg(), normalizeSePay(ipn(intent.id, 'TX-M', 1500)))).status).toBe('review:intent_provider_mismatch');
  });

  it('checkout form signature follows the documented field order and skips empty fields', async () => {
    const fields = { order_amount: '254000', merchant: 'M1', currency: 'VND', operation: 'PURCHASE', order_description: 'd', order_invoice_number: 'bid_1', success_url: 'https://a/s', error_url: 'https://a/e', cancel_url: 'https://a/c', customer_id: '' };
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('k'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(
      'order_amount=254000,merchant=M1,currency=VND,operation=PURCHASE,order_description=d,order_invoice_number=bid_1,success_url=https://a/s,error_url=https://a/e,cancel_url=https://a/c')))));
    expect(await signCheckoutFields('k', fields)).toBe(expected);
  });
});

describe('live payments flag', () => {
  it('A20: PAYMENT_MODE=live is ignored unless LIVE_PAYMENTS=true', () => {
    expect(config({ ...E, PAYMENT_MODE: 'live', LIVE_PAYMENTS: 'false' }).paymentMode).toBe('sandbox');
    expect(config({ ...E, PAYMENT_MODE: 'live', LIVE_PAYMENTS: 'true' }).paymentMode).toBe('live');
    expect(config(E).paymentMode).toBe('simulated');
  });
});
