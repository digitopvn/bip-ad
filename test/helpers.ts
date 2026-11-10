import { env } from 'cloudflare:test';
import { beginCheckout, quote, settle, type Provider } from '../src/domain/bidding';
import { type Board, config } from '../src/domain/config';
import { createProduct, setBlocks, submitProduct } from '../src/domain/products';
import type { Env } from '../src/env';
import { newId } from '../src/lib/ids';
import { iso } from '../src/lib/time';

export const E = env as unknown as Env;
export const db = () => E.DB;
export const cfg = () => config(E);
/** Real-money settings (sandbox) with a low payout minimum: payouts are disabled in simulated mode. */
export const realCfg = () => ({ ...config(E), paymentMode: 'sandbox' as const, minPayout: { USD: 100, VND: 1000 } });

export async function makeUser(name = 'Builder', email: string | null = null) {
  const id = newId('usr');
  await db().prepare('INSERT INTO users (id, display_name, email, created_at) VALUES (?, ?, ?, ?)').bind(id, name, email ?? `${id}@example.test`, iso(Date.now())).run();
  return id;
}

/** A published product with a one-block page, published at `publishedMs`. */
export async function makeProduct(ownerId: string, name: string, publishedMs = Date.now() - 86400_000 * 40) {
  const p = await createProduct(db(), ownerId, { name, tagline: `${name} tagline`, website_url: 'https://example.com' }, newId('k'));
  await setBlocks(db(), ownerId, p.id, [{ type: 'hero', headline: name }]);
  await submitProduct(db(), cfg(), ownerId, p.id);
  await db().batch([
    db().prepare('UPDATE products SET published_at = ? WHERE id = ?').bind(iso(publishedMs), p.id),
    // Backdate the state history with it, so boards as of a past cutoff see the product as published then.
    db().prepare('UPDATE product_state_history SET changed_at = ? WHERE product_id = ?').bind(iso(publishedMs), p.id),
  ]);
  return p.id;
}

/** Quote + checkout + verified settlement at `atMs`. Returns the intent id. */
export async function bid(ownerId: string, productId: string, board: Board, units: number, atMs: number, provider: Provider = 'paypal', walletMinor = 0) {
  const currency = provider === 'paypal' ? 'USD' : 'VND';
  const { intent } = await quote(db(), cfg(), ownerId, { productId, board, rankUnits: units, currency, idempotencyKey: newId('q') }, atMs - 1000);
  const c = await beginCheckout(db(), cfg(), ownerId, intent.id, walletMinor && walletMinor === intent.quote_minor ? 'wallet' : provider, { walletMinor }, atMs - 900);
  const r = await settle(db(), cfg(), {
    intentId: intent.id, provider: c.dueMinor === 0 ? 'wallet' : provider, providerPaymentId: newId('cap'), currency: intent.quote_currency, cashMinor: c.dueMinor, confirmedAtMs: atMs,
  });
  if (r.status !== 'settled') throw new Error(`settle failed: ${JSON.stringify(r)}`);
  return intent.id;
}

export async function ledgerBalancedEverywhere() {
  const r = await db().prepare('SELECT COUNT(*) AS n FROM (SELECT txn_id, currency, SUM(amount_minor) s FROM ledger_entries GROUP BY txn_id, currency HAVING s <> 0)').first<{ n: number }>();
  return r!.n === 0;
}
