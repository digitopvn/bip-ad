// Provider-side checkout creation. In simulated mode nothing leaves the Worker; in sandbox/live
// the real provider is called. Live requires PAYMENT_MODE=live AND LIVE_PAYMENTS=true (see config()).
import type { IntentRow, Provider } from '../domain/bidding';
import type { Config } from '../domain/config';
import { DomainError } from '../domain/errors';
import type { Env } from '../env';
import { iso } from '../lib/time';
import { createOrder } from './paypal';
import { checkoutForm } from './sepay';

/**
 * A provider takes money only once its credentials are set: PAYMENT_MODE switches every provider
 * to sandbox or live at once, so one environment can run PayPal while SePay is not set up yet.
 * In simulated mode nothing leaves the Worker, so every provider is available.
 */
export function providerEnabled(env: Env, cfg: Config, provider: 'paypal' | 'sepay'): boolean {
  if (cfg.paymentMode === 'simulated') return true;
  if (provider === 'paypal') return Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && env.PAYPAL_WEBHOOK_ID);
  return Boolean(env.SEPAY_MERCHANT_ID && env.SEPAY_SECRET_KEY && env.SEPAY_IPN_SECRET);
}

/** Refuse a checkout through a provider that is not set up, before any intent state changes. */
export function assertProviderEnabled(env: Env, cfg: Config, provider: Provider | 'wallet') {
  if (provider !== 'wallet' && !providerEnabled(env, cfg, provider)) {
    throw new DomainError('provider_unavailable', `${provider === 'paypal' ? 'PayPal' : 'SePay'} is not available right now`, 409);
  }
}

export async function createProviderCheckout(env: Env, cfg: Config, intent: IntentRow, provider: Provider): Promise<{ redirectUrl: string | null }> {
  if (cfg.paymentMode === 'simulated') return { redirectUrl: null };
  const due = intent.quote_minor - intent.wallet_applied_minor;
  if (provider === 'paypal') {
    if (intent.provider_order_id) return { redirectUrl: null };
    try {
      const o = await createOrder(env, intent.id, due, `${cfg.origin}/checkout/${intent.id}/paypal-return`, `${cfg.origin}/checkout/${intent.id}?r=cancel`);
      await env.DB.prepare('UPDATE bid_intents SET provider_order_id = ?, updated_at = ? WHERE id = ? AND provider_order_id IS NULL').bind(o.orderId, iso(Date.now()), intent.id).run();
      return { redirectUrl: o.approveUrl };
    } catch (e) {
      console.error('paypal create order failed', e);
      throw new DomainError('provider_unavailable', 'PayPal checkout could not be created', 502);
    }
  }
  // SePay: the browser posts a signed form; /checkout/{id} renders it.
  await checkoutForm(env, intent.id, due, cfg.origin).catch(() => { throw new DomainError('provider_unavailable', 'SePay is not configured', 502); });
  return { redirectUrl: `${cfg.origin}/checkout/${intent.id}` };
}
