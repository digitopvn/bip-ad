// PayPal Orders API v2 adapter. Confirmation only ever comes from a verified webhook
// (PAYMENT.CAPTURE.COMPLETED) or a server-side capture response, never from the browser redirect (A06).
import type { Env } from '../env';

export interface PayPalEvent {
  id: string;
  event_type: string;
  resource: {
    id?: string;
    status?: string;
    custom_id?: string;
    invoice_id?: string;
    amount?: { currency_code: string; value: string };
    links?: { href: string; rel: string }[];
    supplementary_data?: { related_ids?: { order_id?: string } };
  };
}

export const toMinorUSD = (value: string) => {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error(`bad USD amount ${value}`);
  const [w, f = ''] = value.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
};
export const fromMinorUSD = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

async function token(env: Env, fetcher: typeof fetch): Promise<string> {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error('PayPal credentials are not configured');
  const r = await fetcher(`${env.PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`PayPal token ${r.status}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

/** Create an order for the amount still due. PayPal-Request-Id makes retries idempotent. */
export async function createOrder(env: Env, intentId: string, amountMinor: number, returnUrl: string, cancelUrl: string, fetcher: typeof fetch = fetch) {
  const t = await token(env, fetcher);
  const r = await fetcher(`${env.PAYPAL_API_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', 'PayPal-Request-Id': `order-${intentId}` },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ custom_id: intentId, invoice_id: intentId, description: 'BIP.AD Lucky Boost (all-pay)', amount: { currency_code: 'USD', value: fromMinorUSD(amountMinor) } }],
      payment_source: { paypal: { experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } },
    }),
  });
  if (!r.ok) throw new Error(`PayPal create order ${r.status}`);
  const body = (await r.json()) as { id: string; links: { href: string; rel: string }[] };
  const approve = body.links.find(l => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  if (!approve) throw new Error('PayPal order has no approval link');
  return { orderId: body.id, approveUrl: approve };
}

/** Capture after buyer approval. The result is trusted because it comes from PayPal server-to-server. */
export async function captureOrder(env: Env, orderId: string, fetcher: typeof fetch = fetch) {
  const t = await token(env, fetcher);
  const r = await fetcher(`${env.PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', 'PayPal-Request-Id': `capture-${orderId}` },
  });
  if (!r.ok && r.status !== 422) throw new Error(`PayPal capture ${r.status}`);
  const body = (await r.json()) as { status?: string; purchase_units?: { payments?: { captures?: { id: string; status: string; custom_id?: string; amount: { currency_code: string; value: string } }[] } }[] };
  const capture = body.purchase_units?.[0]?.payments?.captures?.[0];
  return { status: body.status, capture };
}

/** Verify a webhook with PayPal's verify-webhook-signature API (A19). */
export async function verifyWebhook(env: Env, headers: Headers, rawBody: string, fetcher: typeof fetch = fetch): Promise<PayPalEvent | null> {
  if (!env.PAYPAL_WEBHOOK_ID) return null;
  const h = (n: string) => headers.get(n) ?? '';
  if (!h('paypal-transmission-id') || !h('paypal-transmission-sig') || !h('paypal-cert-url')) return null;
  let event: PayPalEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const t = await token(env, fetcher);
  const r = await fetcher(`${env.PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: event,
    }),
  });
  if (!r.ok) return null;
  const v = (await r.json()) as { verification_status?: string };
  return v.verification_status === 'SUCCESS' ? event : null;
}

/** Capture id referenced by a refund resource (links rel=up → /captures/{id}). */
export function refundedCaptureId(e: PayPalEvent): string | null {
  const up = e.resource.links?.find(l => l.rel === 'up')?.href;
  return up?.match(/\/captures\/([^/?]+)/)?.[1] ?? null;
}
