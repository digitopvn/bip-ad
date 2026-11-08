// SePay Payment Gateway adapter (VietQR, one-time orders). Only the Gateway IPN flow is used;
// the Bank Webhook flow is deliberately not implemented (brief 4.1: never mix the two).
import type { Env } from '../env';
import { safeEqual } from '../lib/crypto';

export interface SePayIpn {
  timestamp: number;
  notification_type: 'ORDER_PAID' | 'TRANSACTION_VOID' | string;
  order: { id?: string; order_id?: string; order_status?: string; order_currency?: string; order_amount?: string; order_invoice_number?: string };
  transaction: { id?: string; transaction_id?: string; transaction_status?: string; transaction_amount?: string; transaction_currency?: string };
}

const SIGNED_FIELDS = ['order_amount', 'merchant', 'currency', 'operation', 'order_description', 'order_invoice_number', 'customer_id', 'payment_method', 'success_url', 'error_url', 'cancel_url'] as const;

/** Checkout form signature: HMAC-SHA256 over "k=v,k=v" of the non-empty signed fields in documented order, base64. */
export async function signCheckoutFields(secretKey: string, fields: Record<string, string>) {
  const signed = SIGNED_FIELDS.filter(k => fields[k] !== undefined && fields[k] !== '' && fields[k] !== '0').map(k => `${k}=${fields[k]}`).join(',');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed)));
  return btoa(String.fromCharCode(...mac));
}

/** Hosted checkout form fields; the browser POSTs them to SEPAY_CHECKOUT_URL. */
export async function checkoutForm(env: Env, intentId: string, amountVnd: number, origin: string) {
  if (!env.SEPAY_MERCHANT_ID || !env.SEPAY_SECRET_KEY) throw new Error('SePay credentials are not configured');
  const fields: Record<string, string> = {
    order_amount: String(amountVnd),
    merchant: env.SEPAY_MERCHANT_ID,
    currency: 'VND',
    operation: 'PURCHASE',
    order_description: `BIPAD ${intentId}`,
    order_invoice_number: intentId,
    success_url: `${origin}/checkout/${intentId}?r=success`,
    error_url: `${origin}/checkout/${intentId}?r=error`,
    cancel_url: `${origin}/checkout/${intentId}?r=cancel`,
  };
  fields.signature = await signCheckoutFields(env.SEPAY_SECRET_KEY, fields);
  return { action: env.SEPAY_CHECKOUT_URL, fields };
}

/** IPN auth type SECRET_KEY: the X-Secret-Key header must equal the configured IPN secret (A19). */
export function verifyIpn(env: Env, headers: Headers, rawBody: string): SePayIpn | null {
  const secret = env.SEPAY_IPN_SECRET;
  const got = headers.get('x-secret-key');
  if (!secret || !got || !safeEqual(got, secret)) return null;
  try {
    const body = JSON.parse(rawBody) as SePayIpn;
    if (!body || typeof body !== 'object' || !body.order || !body.transaction) return null;
    return body;
  } catch {
    return null;
  }
}

export const vndMinor = (s: string | undefined) => {
  if (!s || !/^\d+(\.0+)?$/.test(s)) return NaN;
  return Number(s.split('.')[0]);
};
