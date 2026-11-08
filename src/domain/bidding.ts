// Quotes, checkout intents, settlement and refunds. Settlement is the only path that creates a
// BidContribution, and it runs exactly once per intent: payments.bid_intent_id, payments
// (provider, provider_payment_id), bid_contributions.bid_intent_id and ledger (kind, reference)
// are all UNIQUE inside one atomic batch (A05).
import { newId } from '../lib/ids';
import { iso, nextCutoffAfter } from '../lib/time';
import { ADS_SHARE_BPS, type Board, BOARD_DURATION_MS, type Config, type Currency, SIMULATED_MAX_RANK_UNITS } from './config';
import { DomainError, forbidden, isConstraintError, isGuardError, notFound } from './errors';
import { acct, decisionStatement, guardStatement, outboxStatement, postingStatements, walletStatements } from './ledger';
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
  const max = cfg.paymentMode === 'simulated' ? SIMULATED_MAX_RANK_UNITS : 100_000_000;
  if (input.rankUnits > max) throw new DomainError('above_maximum', `Increment too large (maximum ${max} rank units${cfg.paymentMode === 'simulated' ? ' in simulated mode' : ''})`);

  const key = `${userId}:${input.idempotencyKey}`;
  const same = (i: IntentRow) => i.product_id === input.productId && i.board === input.board && i.rank_units === input.rankUnits && i.quote_currency === input.currency;
  const existing = await db.prepare('SELECT * FROM bid_intents WHERE idempotency_key = ?').bind(key).first<IntentRow>();
  if (existing) {
    if (!same(existing)) throw new DomainError('idempotency_conflict', 'This idempotency_key was already used for a different quote', 409);
    return { intent: existing, projectedRank: await projectedRank(db, existing.board, existing.product_id, existing.rank_units, nowMs) };
  }

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
  if (!same(intent)) throw new DomainError('idempotency_conflict', 'This idempotency_key was already used for a different quote', 409);
  return { intent, projectedRank: await projectedRank(db, intent.board, intent.product_id, intent.rank_units, nowMs) };
}

export async function projectedRank(db: D1Database, board: Board, productId: string, addUnits: number, nowMs = Date.now()) {
  const rows = await loadStandings(db, board, nowMs);
  const mine = rows.find(r => r.productId === productId);
  const myTotal = (mine?.activeRankUnits ?? 0) + addUnits;
  // Ties at equal bid are decided by referrals/metrics; project conservatively (behind equal bids).
  return rows.filter(r => r.productId !== productId && r.activeRankUnits >= myTotal).length + 1;
}

/**
 * Reserve commission-wallet funds for an intent (A28-A30). Only a fresh quote accepts wallet funds:
 * once checkout started, the amount a provider order or SePay form was built for must not change.
 * The CHECK on available_minor rejects overdrafts atomically; the guard rejects a lost race.
 */
export async function applyWallet(db: D1Database, userId: string, intentId: string, amountMinor: number, nowMs = Date.now()) {
  const intent = await ownedIntent(db, userId, intentId);
  if (intent.wallet_applied_minor > 0) {
    if (intent.wallet_applied_minor === amountMinor) return intent;
    throw new DomainError('wallet_already_applied', 'Wallet funds are already reserved for this intent', 409);
  }
  if (intent.status !== 'quoted' || intent.provider_order_id) {
    throw new DomainError('intent_locked', `Wallet funds can only be applied to a fresh quote before checkout (intent is ${intent.status})`, 409);
  }
  if (Date.parse(intent.quote_expires_at) <= nowMs) throw new DomainError('quote_expired', 'Quote expired; request a new quote', 409);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > intent.quote_minor) throw new DomainError('invalid_amount', `Amount must be 1..${intent.quote_minor} ${intent.quote_currency} minor units`);
  const now = iso(nowMs);
  const resId = newId('wres');
  const u = userId, c = intent.quote_currency;
  try {
    await db.batch([
      db.prepare(`INSERT INTO wallet_reservations (id, user_id, currency, bid_intent_id, amount_minor, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(resId, u, c, intent.id, amountMinor, `bid:${intent.id}`, now),
      db.prepare(`UPDATE bid_intents SET wallet_applied_minor = ?, updated_at = ? WHERE id = ? AND status = 'quoted' AND wallet_applied_minor = 0 AND provider_order_id IS NULL`)
        .bind(amountMinor, now, intent.id),
      guardStatement(db, `EXISTS (SELECT 1 FROM bid_intents WHERE id = ? AND status = 'quoted' AND wallet_applied_minor = ?)`, intent.id, amountMinor),
      ...postingStatements(db, { kind: 'wallet_reserve_bid', referenceId: resId, memo: `Reserve wallet for ${intent.id}`, entries: [
        { account: acct.walletAvailable(u), currency: c, amount: amountMinor },
        { account: acct.walletReservedBid(u), currency: c, amount: -amountMinor },
      ] }, now),
      ...walletStatements(db, u, c, { available: -amountMinor, reservedBid: amountMinor }),
    ]);
  } catch (e) {
    if (isGuardError(e)) throw new DomainError('intent_locked', 'The intent changed concurrently (checkout started or settled); wallet funds were not applied', 409);
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
  /** Simulated (PAYMENT_MODE=simulated) money: booked to a separate cash account and flagged. */
  isTest?: boolean;
  /** Operator resolution of a review may settle an intent that is in needs_review. */
  fromReview?: boolean;
}

export type SettlementResult =
  | { status: 'settled'; contributionId: string; assignedCutoffAt: string }
  | { status: 'duplicate' }
  | { status: 'rejected'; reason: string };

export const cashAccount = (provider: string, isTest: boolean) => (isTest ? acct.cash(`simulated:${provider}`) : acct.cash(provider));

/**
 * Money arrived that cannot be applied automatically. Record it for the operator, move the intent
 * to needs_review and give back any wallet reservation, so nothing is silently kept or locked.
 */
export async function flagCaptureForReview(db: D1Database, s: SettlementInput, intent: IntentRow | null, reason: string) {
  const now = iso(s.confirmedAtMs);
  const stmts: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO payment_reviews (id, provider, event_ref, kind, bid_intent_id, provider_payment_id, currency, amount_minor, reason, is_test, status, created_at)
                VALUES (?, ?, ?, 'capture', ?, ?, ?, ?, ?, ?, 'open', ?) ON CONFLICT (provider, event_ref) DO NOTHING`)
      .bind(newId('prv'), s.provider, `capture:${s.providerPaymentId}`, s.intentId, s.providerPaymentId, s.currency, s.cashMinor, reason, s.isTest ? 1 : 0, now),
    outboxStatement(db, 'PaymentNeedsReview', s.intentId, { provider: s.provider, providerPaymentId: s.providerPaymentId, reason, amount: s.cashMinor, currency: s.currency }, now),
  ];
  if (intent) stmts.push(db.prepare(`UPDATE bid_intents SET status = 'needs_review', updated_at = ? WHERE id = ? AND status IN ('quoted', 'awaiting_payment', 'expired')`).bind(now, intent.id));
  await db.batch(stmts);
  if (intent) await releaseWallet(db, intent.id, `payment needs review: ${reason}`, s.confirmedAtMs);
  return { status: 'rejected' as const, reason };
}

/** Payment verified by the provider (or wallet-only approval by the owner): create exactly one contribution. */
export async function settle(db: D1Database, cfg: Config, s: SettlementInput, allowReferral = true): Promise<SettlementResult> {
  const external = s.provider !== 'wallet';
  const intent = await getIntent(db, s.intentId);
  if (!intent) return external ? flagCaptureForReview(db, s, null, 'unknown_intent') : { status: 'rejected', reason: 'unknown_intent' };
  const paid = await db.prepare('SELECT bid_intent_id, provider, provider_payment_id FROM payments WHERE bid_intent_id = ? OR (provider = ? AND provider_payment_id = ?)')
    .bind(intent.id, s.provider, s.providerPaymentId).first<{ bid_intent_id: string; provider: string; provider_payment_id: string }>();
  if (paid) {
    if (paid.provider === s.provider && paid.provider_payment_id === s.providerPaymentId) return { status: 'duplicate' };
    // A second, different capture for an intent that is already paid: money arrived twice.
    return external ? flagCaptureForReview(db, s, null, 'intent_already_paid') : { status: 'rejected', reason: 'intent_already_paid' };
  }
  // An expired quote still settles when the provider captured the exact locked amount: the money arrived.
  const settleable = ['awaiting_payment', 'expired', ...(s.fromReview ? ['needs_review'] : [])];
  if (!settleable.includes(intent.status)) return external ? flagCaptureForReview(db, s, intent, `intent_${intent.status}`) : { status: 'rejected', reason: `intent_${intent.status}` };
  const due = intent.quote_minor - intent.wallet_applied_minor;
  if (s.currency !== intent.quote_currency || s.cashMinor !== due || external !== (due > 0)) {
    return external ? flagCaptureForReview(db, s, intent, 'amount_mismatch') : { status: 'rejected', reason: 'amount_mismatch' };
  }
  let reservation: { id: string } | null = null;
  if (intent.wallet_applied_minor > 0) {
    reservation = await db.prepare(`SELECT r.id FROM wallet_reservations r LEFT JOIN reservation_closures c ON c.reservation_id = r.id
        WHERE r.bid_intent_id = ? AND c.reservation_id IS NULL`).bind(intent.id).first<{ id: string }>();
    if (!reservation) return external ? flagCaptureForReview(db, s, intent, 'wallet_reservation_missing') : { status: 'rejected', reason: 'wallet_reservation_missing' };
  }

  const now = iso(s.confirmedAtMs);
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
    db.prepare(`INSERT INTO payments (id, bid_intent_id, provider, provider_payment_id, currency, cash_minor, wallet_minor, state, confirmed_at, created_at, is_test)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'captured', ?, ?, ?)`).bind(newId('pay'), intent.id, s.provider, s.providerPaymentId, cur, cash, wallet, now, now, s.isTest ? 1 : 0),
    db.prepare(`INSERT INTO bid_contributions (id, bid_intent_id, product_id, owner_id, board, rank_units, currency, gross_minor, ads_minor, commission_minor, platform_minor,
                starts_at, expires_at, assigned_cutoff_at, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .bind(contributionId, intent.id, intent.product_id, intent.owner_id, intent.board, intent.rank_units, cur, gross, ads, commission, platform, now, expires, assigned, now),
    db.prepare(`UPDATE bid_intents SET status = 'confirmed', updated_at = ? WHERE id = ?`).bind(now, intent.id),
    ...postingStatements(db, { kind: 'bid_settlement', referenceId: intent.id, memo: `${intent.board} bid ${intent.id}${s.isTest ? ' (simulated)' : ''}`, entries: [
      { account: external ? cashAccount(s.provider, !!s.isTest) : acct.cash('internal'), currency: cur, amount: cash },
      { account: acct.walletReservedBid(intent.owner_id), currency: cur, amount: wallet },
      { account: acct.adsPending(intent.board), currency: cur, amount: -ads },
      ...(q ? [{ account: acct.walletPending(q.referrerUserId), currency: cur, amount: -commission }] : []),
      { account: acct.platformRevenue(), currency: cur, amount: -platform },
    ] }, now),
    outboxStatement(db, 'PaymentConfirmed', intent.id, { provider: s.provider, cash, wallet, currency: cur, test: !!s.isTest }, now),
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
      ...qualificationStatements(db, cfg, q, intent.owner_id, intent.id, cur, cash, s.confirmedAtMs, !!s.isTest),
      ...walletStatements(db, q.referrerUserId, cur, { pending: commission }),
    );
  }
  try {
    await db.batch(statements);
    return { status: 'settled', contributionId, assignedCutoffAt: assigned };
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    const dup = await db.prepare('SELECT id FROM payments WHERE bid_intent_id = ? OR (provider = ? AND provider_payment_id = ?)').bind(intent.id, s.provider, s.providerPaymentId).first();
    if (dup) return settle(db, cfg, s, allowReferral); // re-evaluate: duplicate, or a second capture to review
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
  /** Refunded amount when the provider reports it; less than the captured cash is a partial refund. */
  amountMinor?: number;
  /** Provider event id, used to record a partial refund for review exactly once. */
  eventRef?: string;
}

export type RefundResult = { status: 'refunded' | 'duplicate' | 'unknown' | 'partial_review' };

type PaymentRow = { id: string; bid_intent_id: string; currency: string; cash_minor: number; wallet_minor: number; state: string; is_test: number };

/**
 * Refund or chargeback after a bid is active (A07, A32): void the contribution, reverse the split
 * with a corrective posting (never by editing history), claw back any referral commission.
 * payment_reversals makes it happen once per payment; guards make a lost race retry with fresh reads.
 */
export async function refund(db: D1Database, r: RefundInput): Promise<RefundResult> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const pay = await db.prepare('SELECT * FROM payments WHERE provider = ? AND provider_payment_id = ?').bind(r.provider, r.providerPaymentId).first<PaymentRow>();
    if (!pay) return { status: 'unknown' };
    const reversed = await db.prepare('SELECT 1 FROM payment_reversals WHERE payment_id = ?').bind(pay.id).first();
    if (reversed || pay.state !== 'captured') return { status: 'duplicate' };
    const now = iso(r.atMs);
    if (r.amountMinor !== undefined && r.amountMinor < pay.cash_minor) {
      // Partial refund: the bid stays (policy in ADR-0004) until the refunds add up to the captured
      // cash; then the whole payment is reversed like a full refund. Each event is recorded once.
      const reviewId = newId('prv');
      await db.batch([
        db.prepare(`INSERT INTO payment_reviews (id, provider, event_ref, kind, bid_intent_id, provider_payment_id, currency, amount_minor, reason, is_test, status, created_at)
                    VALUES (?, ?, ?, 'partial_refund', ?, ?, ?, ?, 'partial_refund', ?, 'open', ?) ON CONFLICT (provider, event_ref) DO NOTHING`)
          .bind(reviewId, r.provider, r.eventRef ?? `partial:${r.providerPaymentId}:${r.amountMinor}`, pay.bid_intent_id, r.providerPaymentId, pay.currency, r.amountMinor, pay.is_test, now),
        // Written only when this delivery recorded the refund (a redelivery leaves no row with this id).
        db.prepare(`INSERT INTO outbox_events (id, event_type, aggregate_id, payload_json, created_at)
                    SELECT ?, 'PartialRefundNeedsReview', ?, ?, ? WHERE EXISTS (SELECT 1 FROM payment_reviews WHERE id = ?)`)
          .bind(newId('evt'), pay.id, JSON.stringify({ amount: r.amountMinor, captured: pay.cash_minor }), now, reviewId),
      ]);
      const total = await db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS s FROM payment_reviews
          WHERE provider = ? AND provider_payment_id = ? AND kind = 'partial_refund'`).bind(r.provider, r.providerPaymentId).first<{ s: number }>();
      if ((total?.s ?? 0) < pay.cash_minor) return { status: 'partial_review' };
    }
    const ctb = await db.prepare('SELECT * FROM bid_contributions WHERE bid_intent_id = ?').bind(pay.bid_intent_id)
      .first<{ id: string; owner_id: string; board: Board; ads_minor: number; commission_minor: number; platform_minor: number; currency: string }>();
    if (!ctb) return { status: 'unknown' };
    const inCohort = !!(await db.prepare('SELECT 1 FROM revenue_cohort_contributions WHERE bid_contribution_id = ?').bind(ctb.id).first());
    const com = await db.prepare(`SELECT c.id, c.referrer_user_id, c.commission_minor, c.state, c.successful_referral_id FROM referral_commissions c
        WHERE c.qualifying_bid_intent_id = ? AND c.state IN ('pending', 'available')`).bind(pay.bid_intent_id)
      .first<{ id: string; referrer_user_id: string; commission_minor: number; state: 'pending' | 'available'; successful_referral_id: string }>();
    const cur = pay.currency;
    const entries = [
      { account: cashAccount(r.provider, !!pay.is_test), currency: cur, amount: -pay.cash_minor },
      { account: acct.walletAvailable(ctb.owner_id), currency: cur, amount: -pay.wallet_minor },
      // After the cohort was funded the ads fund itself is reduced by a corrective entry; before, the pending pool is.
      { account: inCohort ? acct.adsFund(ctb.board) : acct.adsPending(ctb.board), currency: cur, amount: ctb.ads_minor },
      { account: acct.platformRevenue(), currency: cur, amount: ctb.platform_minor },
    ];
    const statements: D1PreparedStatement[] = [
      db.prepare('INSERT INTO payment_reversals (payment_id, kind, created_at) VALUES (?, ?, ?)').bind(pay.id, r.kind, now),
      // The cohort membership read above must still hold, or the ads account would be wrong.
      guardStatement(db, `${inCohort ? '' : 'NOT '}EXISTS (SELECT 1 FROM revenue_cohort_contributions WHERE bid_contribution_id = ?)`, ctb.id),
    ];
    if (ctb.commission_minor > 0) {
      if (com?.state === 'pending') {
        entries.push({ account: acct.walletPending(com.referrer_user_id), currency: cur, amount: com.commission_minor });
        statements.push(...walletStatements(db, com.referrer_user_id, cur, { pending: -com.commission_minor }));
      } else if (com?.state === 'available') {
        const bal = await db.prepare('SELECT available_minor FROM wallet_balances WHERE user_id = ? AND currency = ?').bind(com.referrer_user_id, cur).first<{ available_minor: number }>();
        const fromAvail = Math.min(bal?.available_minor ?? 0, com.commission_minor);
        const due = com.commission_minor - fromAvail;
        entries.push({ account: acct.walletAvailable(com.referrer_user_id), currency: cur, amount: fromAvail });
        entries.push({ account: acct.clawbackReceivable(com.referrer_user_id), currency: cur, amount: due });
        statements.push(...walletStatements(db, com.referrer_user_id, cur, { available: -fromAvail, clawbackDue: due }));
      } else {
        // Commission already clawed back elsewhere: the platform absorbs that slice of the reversal.
        entries.push({ account: acct.platformRevenue(), currency: cur, amount: ctb.commission_minor });
      }
    }
    if (pay.wallet_minor > 0) statements.push(...walletStatements(db, ctb.owner_id, cur, { available: pay.wallet_minor }));
    if (inCohort && ctb.ads_minor > 0) {
      // The funded flight's hard cap shrinks with the ads fund (never below what is already committed).
      statements.push(db.prepare(`UPDATE ad_flights SET spend_cap_minor = MAX(committed_minor, spend_cap_minor - ?),
            daily_cap_minor = MIN(daily_cap_minor, MAX(committed_minor, spend_cap_minor - ?))
          WHERE cohort_id = (SELECT cohort_id FROM revenue_cohort_contributions WHERE bid_contribution_id = ?)`).bind(ctb.ads_minor, ctb.ads_minor, ctb.id));
    }
    if (com) {
      statements.push(
        db.prepare(`UPDATE referral_commissions SET state = 'clawed_back' WHERE id = ? AND state = ?`).bind(com.id, com.state),
        guardStatement(db, `EXISTS (SELECT 1 FROM referral_commissions WHERE id = ? AND state = 'clawed_back')`, com.id),
        db.prepare(`UPDATE successful_referrals SET status = 'clawed_back' WHERE id = ?`).bind(com.successful_referral_id),
      );
    }
    try {
      await db.batch([
        ...statements,
        ...postingStatements(db, { kind: `bid_${r.kind}`, referenceId: pay.id, memo: `${r.kind} of ${pay.bid_intent_id}`, entries }, now),
        db.prepare(`UPDATE payments SET state = ? WHERE id = ? AND state = 'captured'`).bind(r.kind === 'refund' ? 'refunded' : 'disputed', pay.id),
        db.prepare(`UPDATE bid_contributions SET status = 'voided_after_refund', voided_at = ? WHERE id = ?`).bind(now, ctb.id),
        db.prepare(`UPDATE bid_intents SET status = 'refunded', updated_at = ? WHERE id = ?`).bind(now, pay.bid_intent_id),
        outboxStatement(db, r.kind === 'refund' ? 'RefundRecorded' : 'ChargebackRecorded', pay.id, { contributionId: ctb.id, afterCohort: inCohort }, now),
        db.prepare(`UPDATE payment_reviews SET status = 'settled', resolution = 'payment fully reversed', resolved_at = ?
                    WHERE provider = ? AND provider_payment_id = ? AND kind = 'partial_refund' AND status = 'open'`).bind(now, r.provider, r.providerPaymentId),
      ]);
      return { status: 'refunded' };
    } catch (e) {
      if (!isConstraintError(e)) throw e;
      // A reversal already recorded is the only real duplicate; anything else (a balance or cohort
      // that changed since it was read) is retried with fresh reads.
      if (await db.prepare('SELECT 1 FROM payment_reversals WHERE payment_id = ?').bind(pay.id).first()) return { status: 'duplicate' };
    }
  }
  throw new Error(`refund of ${r.provider}:${r.providerPaymentId} kept conflicting; retry later`);
}

/** Expire stale quotes and release their wallet reservations. Grace keeps late provider captures settle-able. */
export async function expireIntents(db: D1Database, nowMs = Date.now(), graceMs = 3600_000, limit = 100) {
  const cutoff = iso(nowMs - graceMs);
  const { results } = await db.prepare(`SELECT id FROM bid_intents WHERE status IN ('quoted', 'awaiting_payment') AND quote_expires_at < ? ORDER BY quote_expires_at LIMIT ?`)
    .bind(cutoff, limit).all<{ id: string }>();
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

/**
 * Operator resolution of a payment review.
 * - settle: the captured cash equals the full locked quote of an intent with no wallet portion;
 *   the bid settles at the locked price as if the capture had matched.
 * - dismiss: the operator handled the money outside the app (e.g. refunded it at the provider);
 *   the intent, if waiting for review, is closed as failed.
 */
export async function resolvePaymentReview(db: D1Database, cfg: Config, actor: string, reviewId: string, resolution: 'settle' | 'dismiss', note: string, nowMs = Date.now()) {
  const rv = await db.prepare('SELECT * FROM payment_reviews WHERE id = ?').bind(reviewId).first<{
    id: string; provider: Provider; kind: string; bid_intent_id: string | null; provider_payment_id: string | null; currency: string | null; amount_minor: number | null; status: string; is_test: number;
  }>();
  if (!rv) throw notFound('Review not found');
  if (rv.status !== 'open') return { review_id: rv.id, status: rv.status };
  const now = iso(nowMs);
  const close = (status: 'settled' | 'dismissed', extra: D1PreparedStatement[] = []) => db.batch([
    db.prepare(`UPDATE payment_reviews SET status = ?, resolution = ?, resolved_at = ? WHERE id = ? AND status = 'open'`).bind(status, note.slice(0, 300), now, rv.id),
    decisionStatement(db, { actor, action: 'payments.resolve_review', decision: status === 'settled' ? 'allow' : 'deny', reasons: [note.slice(0, 120) || resolution.toUpperCase()], policy: 'payments-v1', resourceId: rv.id }, now),
    ...extra,
  ]);
  if (resolution === 'dismiss') {
    const others = rv.bid_intent_id ? await db.prepare(`SELECT 1 FROM payment_reviews WHERE bid_intent_id = ? AND status = 'open' AND kind = 'capture' AND id <> ?`).bind(rv.bid_intent_id, rv.id).first() : null;
    const held = !others && rv.bid_intent_id ? (await getIntent(db, rv.bid_intent_id))?.status === 'needs_review' : false;
    await close('dismissed', held ? [db.prepare(`UPDATE bid_intents SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'needs_review'`).bind(now, rv.bid_intent_id)] : []);
    // An intent that never moved to needs_review (e.g. a wrong-provider capture) can still be paid: keep its wallet reservation.
    if (held) await releaseWallet(db, rv.bid_intent_id!, 'payment review dismissed', nowMs);
    return { review_id: rv.id, status: 'dismissed' };
  }
  const intent = rv.bid_intent_id ? await getIntent(db, rv.bid_intent_id) : null;
  if (rv.kind !== 'capture' || !intent || !rv.provider_payment_id || intent.wallet_applied_minor !== 0 || rv.currency !== intent.quote_currency || rv.amount_minor !== intent.quote_minor) {
    throw new DomainError('not_settleable', 'Only a capture of exactly the full locked quote (no wallet portion) can be settled; dismiss it and refund at the provider instead', 409);
  }
  // Claim first: a provider reversal racing this settlement then sees a settled review and retries
  // until the payment exists, instead of dismissing a review that is being settled.
  const claim = await db.prepare(`UPDATE payment_reviews SET status = 'settled', resolution = ?, resolved_at = ? WHERE id = ? AND status = 'open'`).bind(note.slice(0, 300), now, rv.id).run();
  if (!claim.meta.changes) {
    const cur = await db.prepare('SELECT status FROM payment_reviews WHERE id = ?').bind(rv.id).first<{ status: string }>();
    return { review_id: rv.id, status: cur?.status ?? 'unknown' };
  }
  let r: SettlementResult;
  try {
    r = await settle(db, cfg, { intentId: intent.id, provider: rv.provider, providerPaymentId: rv.provider_payment_id, currency: rv.currency!, cashMinor: rv.amount_minor!, confirmedAtMs: nowMs, isTest: !!rv.is_test, fromReview: true });
  } catch (e) {
    await db.prepare(`UPDATE payment_reviews SET status = 'open', resolution = NULL, resolved_at = NULL WHERE id = ?`).bind(rv.id).run();
    throw e;
  }
  if (r.status !== 'settled' && r.status !== 'duplicate') {
    await db.prepare(`UPDATE payment_reviews SET status = 'open', resolution = NULL, resolved_at = NULL WHERE id = ?`).bind(rv.id).run();
    throw new DomainError('not_settleable', `Settlement refused: ${r.reason}`, 409);
  }
  await decisionStatement(db, { actor, action: 'payments.resolve_review', decision: 'allow', reasons: [note.slice(0, 120) || 'SETTLE'], policy: 'payments-v1', resourceId: rv.id }, now).run();
  return { review_id: rv.id, status: 'settled', settlement: r };
}
