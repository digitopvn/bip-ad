// Quotes, checkout intents, settlement and refunds. Settlement is the only path that creates a
// BidContribution, and it runs exactly once per intent: payments.bid_intent_id, payments
// (provider, provider_payment_id), bid_contributions.bid_intent_id and ledger (kind, reference)
// are all UNIQUE inside one atomic batch (A05).
import { newId } from '../lib/ids';
import { iso, nextCutoffAfter } from '../lib/time';
import { ADS_SHARE_BPS, type Board, BOARD_DURATION_MS, type Config, type Currency } from './config';
import { DomainError, forbidden, isConstraintError, notFound } from './errors';
import { acct, outboxStatement, postingStatements, walletStatements } from './ledger';
import { getProduct } from './products';
import { loadStandings } from './ranking';
import { qualificationStatements, referralQualification } from './referrals';

export type Provider = 'paypal' | 'sepay';
export const PROVIDER_CURRENCY: Record<Provider, Currency> = { paypal: 'USD', sepay: 'VND' };

export interface IntentRow {
  id: string;
  product_id: string;
  owner_id: string;
  board: Board;
  rank_units: number;
  quote_currency: Currency;
  quote_minor: number;
  fx_rate: string | null;
  fx_source: string;
  quoted_at: string;
  quote_expires_at: string;
  wallet_applied_minor: number;
  status: 'quoted' | 'awaiting_payment' | 'confirmed' | 'expired' | 'failed' | 'cancelled' | 'refunded' | 'needs_review';
  provider: string | null;
  provider_order_id: string | null;
  created_at: string;
}

export async function getIntent(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM bid_intents WHERE id = ?').bind(id).first<IntentRow>();
}

export async function ownedIntent(db: D1Database, userId: string, id: string) {
  const i = await getIntent(db, id);
  if (!i) throw notFound('Bid intent not found');
  if (i.owner_id !== userId) throw forbidden('This bid intent belongs to another account');
  return i;
}

/** Price in the quote currency. USD: 1 rank unit = 1 cent. VND: rounded up to the whole dong at the locked rate. */
export function priceFor(rankUnits: number, currency: Currency, fxUsdVnd: number) {
  if (currency === 'USD') return { minor: rankUnits, fxRate: null, fxSource: 'identity', rounding: 'none' };
  return { minor: Math.ceil((rankUnits * fxUsdVnd) / 100), fxRate: String(fxUsdVnd), fxSource: 'config:FX_USD_VND', rounding: 'ceil_to_1_vnd' };
}

export interface QuoteInput {
  productId: string;
  board: Board;
  rankUnits: number;
  currency: Currency;
  idempotencyKey: string;
}

export async function quote(db: D1Database, cfg: Config, userId: string, input: QuoteInput, nowMs = Date.now()) {
  const product = await getProduct(db, input.productId);
  if (!product) throw notFound('Product not found');
  if (product.owner_id !== userId) throw forbidden('Only the product owner can bid on it');
  if (product.status !== 'published') throw new DomainError('not_published', 'Only published products can be boosted', 409);
  const floor = Math.max(cfg.minBidUnits, cfg.minIncrementUnits);
  if (!Number.isSafeInteger(input.rankUnits) || input.rankUnits < floor) throw new DomainError('below_minimum', `Minimum increment is ${floor} rank units (USD cents)`);
  if (input.rankUnits > 100_000_000) throw new DomainError('above_maximum', 'Increment too large');

  const key = `${userId}:${input.idempotencyKey}`;
  const existing = await db.prepare('SELECT * FROM bid_intents WHERE idempotency_key = ?').bind(key).first<IntentRow>();
  if (existing) return { intent: existing, projectedRank: await projectedRank(db, existing.board, existing.product_id, existing.rank_units, nowMs) };

  const price = priceFor(input.rankUnits, input.currency, cfg.fxUsdVnd);
  const id = newId('bid');
  const now = iso(nowMs);
  try {
    await db.prepare(`INSERT INTO bid_intents (id, product_id, owner_id, board, rank_units, quote_currency, quote_minor, fx_rate, fx_source, rounding_rule,
        quoted_at, quote_expires_at, status, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?, ?)`)
      .bind(id, product.id, userId, input.board, input.rankUnits, input.currency, price.minor, price.fxRate, price.fxSource, price.rounding,
        now, iso(nowMs + cfg.quoteTtlMs), key, now, now).run();
  } catch (e) {
    if (!isConstraintError(e)) throw e;
  }
  const intent = (await db.prepare('SELECT * FROM bid_intents WHERE idempotency_key = ?').bind(key).first<IntentRow>())!;
  return { intent, projectedRank: await projectedRank(db, intent.board, intent.product_id, intent.rank_units, nowMs) };
}

export async function projectedRank(db: D1Database, board: Board, productId: string, addUnits: number, nowMs = Date.now()) {
  const rows = await loadStandings(db, board, nowMs);
  const mine = rows.find(r => r.productId === productId);
  const myTotal = (mine?.activeRankUnits ?? 0) + addUnits;
  // Ties at equal bid are decided by referrals/metrics; project conservatively (behind equal bids).
  return rows.filter(r => r.productId !== productId && r.activeRankUnits >= myTotal).length + 1;
}

/** Reserve commission-wallet funds for an intent (A28-A30). The CHECK on available_minor rejects overdrafts atomically. */
export async function applyWallet(db: D1Database, userId: string, intentId: string, amountMinor: number, nowMs = Date.now()) {
  const intent = await ownedIntent(db, userId, intentId);
  if (!['quoted', 'awaiting_payment'].includes(intent.status)) throw new DomainError('intent_closed', `Intent is ${intent.status}`, 409);
  if (Date.parse(intent.quote_expires_at) <= nowMs) throw new DomainError('quote_expired', 'Quote expired; request a new quote', 409);
  if (intent.wallet_applied_minor > 0) {
    if (intent.wallet_applied_minor === amountMinor) return intent;
    throw new DomainError('wallet_already_applied', 'Wallet funds are already reserved for this intent', 409);
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > intent.quote_minor) throw new DomainError('invalid_amount', `Amount must be 1..${intent.quote_minor} ${intent.quote_currency} minor units`);
  const now = iso(nowMs);
  const resId = newId('wres');
  const u = userId, c = intent.quote_currency;
  try {
    await db.batch([
      db.prepare(`INSERT INTO wallet_reservations (id, user_id, currency, bid_intent_id, amount_minor, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(resId, u, c, intent.id, amountMinor, `bid:${intent.id}`, now),
      db.prepare(`UPDATE bid_intents SET wallet_applied_minor = ?, updated_at = ? WHERE id = ? AND wallet_applied_minor = 0`).bind(amountMinor, now, intent.id),
      ...postingStatements(db, { kind: 'wallet_reserve_bid', referenceId: resId, memo: `Reserve wallet for ${intent.id}`, entries: [
        { account: acct.walletAvailable(u), currency: c, amount: amountMinor },
        { account: acct.walletReservedBid(u), currency: c, amount: -amountMinor },
      ] }, now),
      ...walletStatements(db, u, c, { available: -amountMinor, reservedBid: amountMinor }),
    ]);
  } catch (e) {
    if (isConstraintError(e)) throw new DomainError('insufficient_wallet', 'Not enough available commission balance, or funds already reserved', 409);
    throw e;
  }
  return (await getIntent(db, intent.id))!;
}

/** Release an unconsumed wallet reservation exactly once (reservation_closures PK). */
export async function releaseWallet(db: D1Database, intentId: string, reason: string, nowMs = Date.now()) {
  const res = await db.prepare(`SELECT r.* FROM wallet_reservations r LEFT JOIN reservation_closures c ON c.reservation_id = r.id
      WHERE r.bid_intent_id = ? AND c.reservation_id IS NULL`).bind(intentId).first<{ id: string; user_id: string; currency: string; amount_minor: number }>();
  if (!res) return false;
  const now = iso(nowMs);
  try {
    await db.batch([
      db.prepare(`INSERT INTO reservation_closures (reservation_id, outcome, closed_at) VALUES (?, 'released', ?)`).bind(res.id, now),
      ...postingStatements(db, { kind: 'wallet_release_bid', referenceId: res.id, memo: `Release wallet: ${reason}`, entries: [
        { account: acct.walletReservedBid(res.user_id), currency: res.currency, amount: res.amount_minor },
        { account: acct.walletAvailable(res.user_id), currency: res.currency, amount: -res.amount_minor },
      ] }, now),
      ...walletStatements(db, res.user_id, res.currency, { available: res.amount_minor, reservedBid: -res.amount_minor }),
    ]);
    return true;
  } catch (e) {
    if (isConstraintError(e)) return false; // already consumed or released
    throw e;
  }
}

export interface CheckoutResult {
  intent: IntentRow;
  checkoutUrl: string;
  dueMinor: number;
}

/** Moves a quote to awaiting_payment for a provider. Never charges anyone: the human pays on /checkout/{id}. */
export async function beginCheckout(db: D1Database, cfg: Config, userId: string, intentId: string, provider: Provider | 'wallet', opts: { walletMinor?: number; providerOrderId?: string } = {}, nowMs = Date.now()): Promise<CheckoutResult> {
  let intent = await ownedIntent(db, userId, intentId);
  if (intent.status === 'confirmed') return { intent, checkoutUrl: `${cfg.origin}/checkout/${intent.id}`, dueMinor: 0 };
  if (!['quoted', 'awaiting_payment'].includes(intent.status)) throw new DomainError('intent_closed', `Intent is ${intent.status}`, 409);
  if (Date.parse(intent.quote_expires_at) <= nowMs) throw new DomainError('quote_expired', 'Quote expired; request a new quote', 409);
  if (provider !== 'wallet' && PROVIDER_CURRENCY[provider] !== intent.quote_currency) {
    throw new DomainError('currency_mismatch', `${provider} pays ${PROVIDER_CURRENCY[provider]} quotes; this quote is ${intent.quote_currency}`);
  }
  if (opts.walletMinor && opts.walletMinor > 0) intent = await applyWallet(db, userId, intent.id, opts.walletMinor, nowMs);
  const due = intent.quote_minor - intent.wallet_applied_minor;
  if (provider === 'wallet' && due > 0) throw new DomainError('wallet_insufficient_for_full', 'Wallet covers only part of this quote; choose paypal or sepay for the rest');
  const now = iso(nowMs);
  await db.prepare(`UPDATE bid_intents SET status = 'awaiting_payment', provider = ?, provider_order_id = COALESCE(?, provider_order_id), updated_at = ?
                    WHERE id = ? AND status IN ('quoted', 'awaiting_payment')`)
    .bind(provider, opts.providerOrderId ?? null, now, intent.id).run();
  intent = (await getIntent(db, intent.id))!;
  return { intent, checkoutUrl: `${cfg.origin}/checkout/${intent.id}`, dueMinor: due };
}

export interface SettlementInput {
  intentId: string;
  provider: Provider | 'wallet';
  providerPaymentId: string;
  currency: string;
  cashMinor: number;
  confirmedAtMs: number;
}

export type SettlementResult =
  | { status: 'settled'; contributionId: string; assignedCutoffAt: string }
  | { status: 'duplicate' }
  | { status: 'rejected'; reason: string };

/** Payment verified by the provider (or wallet-only approval by the owner): create exactly one contribution. */
export async function settle(db: D1Database, cfg: Config, s: SettlementInput, allowReferral = true): Promise<SettlementResult> {
  const intent = await getIntent(db, s.intentId);
  if (!intent) return { status: 'rejected', reason: 'unknown_intent' };
  const paid = await db.prepare('SELECT id FROM payments WHERE bid_intent_id = ? OR (provider = ? AND provider_payment_id = ?)').bind(intent.id, s.provider, s.providerPaymentId).first();
  if (paid) return { status: 'duplicate' };
  // An expired quote still settles when the provider captured the exact locked amount: the money arrived.
  if (!['awaiting_payment', 'expired'].includes(intent.status)) return { status: 'rejected', reason: `intent_${intent.status}` };
  const due = intent.quote_minor - intent.wallet_applied_minor;
  const now = iso(s.confirmedAtMs);
  if (s.currency !== intent.quote_currency || s.cashMinor !== due || (s.provider === 'wallet') !== (due === 0)) {
    await db.prepare(`UPDATE bid_intents SET status = 'needs_review', updated_at = ? WHERE id = ? AND status IN ('awaiting_payment', 'expired')`).bind(now, intent.id).run();
    return { status: 'rejected', reason: 'amount_mismatch' };
  }
  let reservation: { id: string } | null = null;
  if (intent.wallet_applied_minor > 0) {
    reservation = await db.prepare(`SELECT r.id FROM wallet_reservations r LEFT JOIN reservation_closures c ON c.reservation_id = r.id
        WHERE r.bid_intent_id = ? AND c.reservation_id IS NULL`).bind(intent.id).first<{ id: string }>();
    if (!reservation) return { status: 'rejected', reason: 'wallet_reservation_missing' };
  }

  const gross = intent.quote_minor;
  const cash = s.cashMinor;
  const wallet = intent.wallet_applied_minor;
  const cur = intent.quote_currency;
  const ads = Math.floor((gross * ADS_SHARE_BPS) / 10000);
  const q = allowReferral ? await referralQualification(db, intent.owner_id, cash) : null;
  const commission = q?.commissionMinor ?? 0;
  const platform = gross - ads - commission;
  const contributionId = newId('ctb');
  const assigned = iso(nextCutoffAfter(s.confirmedAtMs));
  const expires = iso(s.confirmedAtMs + BOARD_DURATION_MS[intent.board]);

  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO payments (id, bid_intent_id, provider, provider_payment_id, currency, cash_minor, wallet_minor, state, confirmed_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'captured', ?, ?)`).bind(newId('pay'), intent.id, s.provider, s.providerPaymentId, cur, cash, wallet, now, now),
    db.prepare(`INSERT INTO bid_contributions (id, bid_intent_id, product_id, owner_id, board, rank_units, currency, gross_minor, ads_minor, commission_minor, platform_minor,
                starts_at, expires_at, assigned_cutoff_at, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .bind(contributionId, intent.id, intent.product_id, intent.owner_id, intent.board, intent.rank_units, cur, gross, ads, commission, platform, now, expires, assigned, now),
    db.prepare(`UPDATE bid_intents SET status = 'confirmed', updated_at = ? WHERE id = ?`).bind(now, intent.id),
    ...postingStatements(db, { kind: 'bid_settlement', referenceId: intent.id, memo: `${intent.board} bid ${intent.id}`, entries: [
      { account: acct.cash(s.provider === 'wallet' ? 'internal' : s.provider), currency: cur, amount: cash },
      { account: acct.walletReservedBid(intent.owner_id), currency: cur, amount: wallet },
      { account: acct.adsPending(intent.board), currency: cur, amount: -ads },
      ...(q ? [{ account: acct.walletPending(q.referrerUserId), currency: cur, amount: -commission }] : []),
      { account: acct.platformRevenue(), currency: cur, amount: -platform },
    ] }, now),
    outboxStatement(db, 'PaymentConfirmed', intent.id, { provider: s.provider, cash, wallet, currency: cur }, now),
    outboxStatement(db, 'ContributionActivated', contributionId, { board: intent.board, productId: intent.product_id, rankUnits: intent.rank_units, expiresAt: expires }, now),
  ];
  if (reservation) {
    statements.push(
      db.prepare(`INSERT INTO reservation_closures (reservation_id, outcome, closed_at) VALUES (?, 'consumed', ?)`).bind(reservation.id, now),
      ...walletStatements(db, intent.owner_id, cur, { reservedBid: -wallet }),
    );
  }
  if (q) {
    statements.push(
      ...qualificationStatements(db, cfg, q, intent.owner_id, intent.id, cur, cash, s.confirmedAtMs),
      ...walletStatements(db, q.referrerUserId, cur, { pending: commission }),
    );
  }
  try {
    await db.batch(statements);
    return { status: 'settled', contributionId, assignedCutoffAt: assigned };
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    const dup = await db.prepare('SELECT id FROM payments WHERE bid_intent_id = ? OR (provider = ? AND provider_payment_id = ?)').bind(intent.id, s.provider, s.providerPaymentId).first();
    if (dup) return { status: 'duplicate' };
    // A concurrent first bid by the same referred buyer won the referral race: settle without it.
    if (q) return settle(db, cfg, s, false);
    throw e;
  }
}

export interface RefundInput {
  provider: Provider;
  providerPaymentId: string;
  kind: 'refund' | 'chargeback';
  atMs: number;
}

/**
 * Refund or chargeback after a bid is active (A07, A32): void the contribution, reverse the split
 * with a corrective posting (never by editing history), claw back any referral commission.
 */
export async function refund(db: D1Database, r: RefundInput): Promise<{ status: 'refunded' | 'duplicate' | 'unknown' }> {
  const pay = await db.prepare('SELECT * FROM payments WHERE provider = ? AND provider_payment_id = ?').bind(r.provider, r.providerPaymentId)
    .first<{ id: string; bid_intent_id: string; currency: string; cash_minor: number; wallet_minor: number; state: string }>();
  if (!pay) return { status: 'unknown' };
  if (pay.state !== 'captured') return { status: 'duplicate' };
  const ctb = await db.prepare('SELECT * FROM bid_contributions WHERE bid_intent_id = ?').bind(pay.bid_intent_id)
    .first<{ id: string; owner_id: string; board: Board; ads_minor: number; commission_minor: number; platform_minor: number; currency: string }>();
  if (!ctb) return { status: 'unknown' };
  const inCohort = await db.prepare('SELECT 1 FROM revenue_cohort_contributions WHERE bid_contribution_id = ?').bind(ctb.id).first();
  const com = await db.prepare(`SELECT c.id, c.referrer_user_id, c.commission_minor, c.state, c.successful_referral_id FROM referral_commissions c
      WHERE c.qualifying_bid_intent_id = ? AND c.state IN ('pending', 'available')`).bind(pay.bid_intent_id)
    .first<{ id: string; referrer_user_id: string; commission_minor: number; state: string; successful_referral_id: string }>();
  const now = iso(r.atMs);
  const cur = pay.currency;
  const entries = [
    { account: acct.cash(r.provider), currency: cur, amount: -pay.cash_minor },
    { account: acct.walletAvailable(ctb.owner_id), currency: cur, amount: -pay.wallet_minor },
    // After the cohort was funded the ads fund itself is reduced by a corrective entry; before, the pending pool is.
    { account: inCohort ? acct.adsFund(ctb.board) : acct.adsPending(ctb.board), currency: cur, amount: ctb.ads_minor },
    { account: acct.platformRevenue(), currency: cur, amount: ctb.platform_minor },
  ];
  const statements: D1PreparedStatement[] = [];
  let platformExtra = 0;
  if (ctb.commission_minor > 0) {
    if (com && com.state === 'pending') {
      entries.push({ account: acct.walletPending(com.referrer_user_id), currency: cur, amount: com.commission_minor });
      statements.push(...walletStatements(db, com.referrer_user_id, cur, { pending: -com.commission_minor }));
    } else if (com && com.state === 'available') {
      const bal = await db.prepare('SELECT available_minor FROM wallet_balances WHERE user_id = ? AND currency = ?').bind(com.referrer_user_id, cur).first<{ available_minor: number }>();
      const fromAvail = Math.min(bal?.available_minor ?? 0, com.commission_minor);
      const due = com.commission_minor - fromAvail;
      entries.push({ account: acct.walletAvailable(com.referrer_user_id), currency: cur, amount: fromAvail });
      entries.push({ account: acct.clawbackReceivable(com.referrer_user_id), currency: cur, amount: due });
      statements.push(...walletStatements(db, com.referrer_user_id, cur, { available: -fromAvail, clawbackDue: due }));
    } else {
      // Commission already clawed back elsewhere: the platform absorbs that slice of the reversal.
      platformExtra = ctb.commission_minor;
    }
  }
  if (platformExtra) entries.push({ account: acct.platformRevenue(), currency: cur, amount: platformExtra });
  if (pay.wallet_minor > 0) statements.push(...walletStatements(db, ctb.owner_id, cur, { available: pay.wallet_minor }));
  if (com) {
    statements.push(
      db.prepare(`UPDATE referral_commissions SET state = 'clawed_back' WHERE id = ?`).bind(com.id),
      db.prepare(`UPDATE successful_referrals SET status = 'clawed_back' WHERE id = ?`).bind(com.successful_referral_id),
    );
  }
  try {
    await db.batch([
      ...postingStatements(db, { kind: `bid_${r.kind}`, referenceId: pay.id, memo: `${r.kind} of ${pay.bid_intent_id}`, entries }, now),
      db.prepare(`UPDATE payments SET state = ? WHERE id = ? AND state = 'captured'`).bind(r.kind === 'refund' ? 'refunded' : 'disputed', pay.id),
      db.prepare(`UPDATE bid_contributions SET status = 'voided_after_refund', voided_at = ? WHERE id = ?`).bind(now, ctb.id),
      db.prepare(`UPDATE bid_intents SET status = 'refunded', updated_at = ? WHERE id = ?`).bind(now, pay.bid_intent_id),
      ...statements,
      outboxStatement(db, r.kind === 'refund' ? 'RefundRecorded' : 'ChargebackRecorded', pay.id, { contributionId: ctb.id, afterCohort: !!inCohort }, now),
    ]);
    return { status: 'refunded' };
  } catch (e) {
    if (isConstraintError(e)) return { status: 'duplicate' };
    throw e;
  }
}

/** Expire stale quotes and release their wallet reservations. Grace keeps late provider captures settle-able. */
export async function expireIntents(db: D1Database, nowMs = Date.now(), graceMs = 3600_000) {
  const cutoff = iso(nowMs - graceMs);
  const { results } = await db.prepare(`SELECT id FROM bid_intents WHERE status IN ('quoted', 'awaiting_payment') AND quote_expires_at < ?`).bind(cutoff).all<{ id: string }>();
  for (const { id } of results) {
    await db.prepare(`UPDATE bid_intents SET status = 'expired', updated_at = ? WHERE id = ? AND status IN ('quoted', 'awaiting_payment')`).bind(iso(nowMs), id).run();
    await releaseWallet(db, id, 'quote expired', nowMs);
  }
  return results.length;
}

export async function intentStatus(db: D1Database, userId: string, intentId: string, nowMs = Date.now()) {
  const intent = await ownedIntent(db, userId, intentId);
  const payment = await db.prepare('SELECT provider, currency, cash_minor, wallet_minor, state, confirmed_at FROM payments WHERE bid_intent_id = ?').bind(intent.id).first();
  const contribution = await db.prepare('SELECT id, rank_units, starts_at, expires_at, assigned_cutoff_at, status FROM bid_contributions WHERE bid_intent_id = ?').bind(intent.id).first();
  const rows = await loadStandings(db, intent.board, nowMs);
  const mine = rows.find(r => r.productId === intent.product_id);
  return {
    intent_id: intent.id,
    status: intent.status,
    board: intent.board,
    rank_units: intent.rank_units,
    quote: { currency: intent.quote_currency, amount_minor: intent.quote_minor, wallet_applied_minor: intent.wallet_applied_minor, expires_at: intent.quote_expires_at },
    payment,
    contribution,
    current_rank: mine?.rank ?? null,
    active_rank_units: mine?.activeRankUnits ?? 0,
  };
}
