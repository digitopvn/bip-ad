// Provider-side checkout creation. In simulated mode nothing leaves the Worker; in sandbox/live
// the real provider is called. Live requires PAYMENT_MODE=live AND LIVE_PAYMENTS=true (see config()).
import type { IntentRow, Provider } from '../domain/bidding';
import type { Config } from '../domain/config';
import { DomainError } from '../domain/errors';
import type { Env } from '../env';
import { iso } from '../lib/time';
import { createOrder } from './paypal';
import { checkoutForm } from './sepay';

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
