// Commission wallet: vesting, balances, payout requests and the manual 01-10 payout window.
import { newId } from '../lib/ids';
import type { Env } from '../env';
import { canSealPii, decryptField, encryptField, type PiiKeyring } from '../lib/crypto';
import { ictDate, iso } from '../lib/time';
import { type Config, type Currency, REFERRAL_POLICY_VERSION } from './config';
import { DomainError, isConstraintError, notFound } from './errors';
import { acct, decisionStatement, guardStatement, outboxStatement, postingStatements, walletStatements } from './ledger';

export async function walletBalances(db: D1Database, userId: string) {
  const { results } = await db.prepare('SELECT * FROM wallet_balances WHERE user_id = ? ORDER BY currency').bind(userId).all<{
    currency: string; pending_minor: number; available_minor: number; reserved_bid_minor: number; reserved_payout_minor: number; paid_minor: number; clawback_due_minor: number;
  }>();
  return results.map(r => ({
    currency: r.currency,
    pending_minor: r.pending_minor,
    available_minor: r.available_minor,
    reserved_for_bid_minor: r.reserved_bid_minor,
    reserved_for_payout_minor: r.reserved_payout_minor,
    paid_minor: r.paid_minor,
    clawback_due_minor: r.clawback_due_minor,
  }));
}

/** Move commissions whose hold period ended from pending to available (and count the referral as successful). */
export async function vestCommissions(db: D1Database, nowMs = Date.now(), limit = 100) {
  const now = iso(nowMs);
  const { results } = await db.prepare(`SELECT c.id, c.referrer_user_id, c.currency, c.commission_minor, c.successful_referral_id, c.vest_at
      FROM referral_commissions c WHERE c.state = 'pending' AND c.vest_at <= ? ORDER BY c.vest_at LIMIT ?`).bind(now, limit).all<{
    id: string; referrer_user_id: string; currency: string; commission_minor: number; successful_referral_id: string; vest_at: string;
  }>();
  let vested = 0;
  for (const c of results) {
    try {
      await db.batch([
        db.prepare(`UPDATE referral_commissions SET state = 'available' WHERE id = ? AND state = 'pending'`).bind(c.id),
        // A commission clawed back since the SELECT must not become spendable: abort the batch.
        guardStatement(db, `EXISTS (SELECT 1 FROM referral_commissions WHERE id = ? AND state = 'available')`, c.id),
        // vested_at is the policy instant, not the job time, so standings at any cutoff are reproducible.
        db.prepare(`UPDATE successful_referrals SET status = 'vested', vested_at = ? WHERE id = ? AND status = 'pending'`).bind(c.vest_at, c.successful_referral_id),
        ...postingStatements(db, { kind: 'commission_vest', referenceId: c.id, memo: `Commission ${c.id} available`, entries: [
          { account: acct.walletPending(c.referrer_user_id), currency: c.currency, amount: c.commission_minor },
          { account: acct.walletAvailable(c.referrer_user_id), currency: c.currency, amount: -c.commission_minor },
        ] }, now),
        ...walletStatements(db, c.referrer_user_id, c.currency, { pending: -c.commission_minor, available: c.commission_minor }),
        outboxStatement(db, 'CommissionAvailable', c.id, { referrer: c.referrer_user_id }, now),
      ]);
      vested++;
    } catch (e) {
      if (!isConstraintError(e)) throw e;
    }
  }
  // Referrals that qualified with a zero commission (rounding) still vest.
  await db.prepare(`UPDATE successful_referrals SET status = 'vested', vested_at = vest_at WHERE status = 'pending' AND vest_at <= ?
      AND NOT EXISTS (SELECT 1 FROM referral_commissions c WHERE c.successful_referral_id = successful_referrals.id AND c.state = 'pending')`).bind(now).run();
  return vested;
}

/** PII keys from the worker secrets. SESSION_SECRET only opens beneficiary references stored before PII_ENCRYPTION_KEY existed. */
export const piiKeys = (env: Pick<Env, 'PII_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY_PREVIOUS' | 'SESSION_SECRET'>): PiiKeyring => ({
  current: env.PII_ENCRYPTION_KEY || undefined,
  previous: env.PII_ENCRYPTION_KEY_PREVIOUS || undefined,
  legacy: env.SESSION_SECRET || undefined,
});

export interface PayoutInput {
  currency: Currency;
  amountMinor: number;
  payoutMethod: 'bank_transfer' | 'paypal';
  beneficiaryReference: string;
  idempotencyKey: string;
}

/** Reserve available balance for a payout. Concurrent bid/payout on the same funds: only one passes the CHECK (A30). */
export async function requestPayout(db: D1Database, cfg: Config, keys: PiiKeyring, userId: string, p: PayoutInput, nowMs = Date.now()) {
  const key = `${userId}:${p.idempotencyKey}`;
  const existing = await db.prepare('SELECT id, state, currency, requested_minor FROM payout_requests WHERE idempotency_key = ?').bind(key).first();
  if (existing) return existing;
  if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor < cfg.minPayout[p.currency]) {
    throw new DomainError('below_minimum_payout', `Minimum payout is ${cfg.minPayout[p.currency]} ${p.currency} minor units`);
  }
  // Simulated money never becomes a real payout: no payouts in simulated mode, and test
  // commissions are excluded from the payable balance in every mode.
  if (cfg.paymentMode === 'simulated') throw new DomainError('payouts_disabled', 'Payouts are disabled while payments run in simulated mode', 409);
  // Beneficiary details are never sealed with a fallback key: refuse the request until the key is set.
  if (!canSealPii(keys)) throw new DomainError('payouts_unavailable', 'Payouts are temporarily unavailable: the payout encryption key (PII_ENCRYPTION_KEY, at least 32 characters) is not configured', 503);
  const bal = await db.prepare(`SELECT b.available_minor - COALESCE((SELECT SUM(c.commission_minor) FROM referral_commissions c
      WHERE c.referrer_user_id = b.user_id AND c.currency = b.currency AND c.is_test = 1 AND c.state = 'available'), 0) AS payable
      FROM wallet_balances b WHERE b.user_id = ? AND b.currency = ?`).bind(userId, p.currency).first<{ payable: number }>();
  if ((bal?.payable ?? 0) < p.amountMinor) throw new DomainError('insufficient_wallet', 'Not enough available commission balance from real payments', 409);
  const ref = p.beneficiaryReference.trim();
  if (ref.length < 4 || ref.length > 200) throw new DomainError('invalid_beneficiary', 'beneficiary_reference must be 4-200 characters');
  const now = iso(nowMs);
  const id = newId('pyr');
  const resId = newId('wres');
  try {
    await db.batch([
      db.prepare(`INSERT INTO payout_requests (id, user_id, currency, requested_minor, state, payout_method, beneficiary_reference, idempotency_key, requested_at, updated_at)
                  VALUES (?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?)`)
        .bind(id, userId, p.currency, p.amountMinor, p.payoutMethod, await encryptField(keys, ref), key, now, now),
      db.prepare(`INSERT INTO wallet_reservations (id, user_id, currency, payout_request_id, amount_minor, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(resId, userId, p.currency, id, p.amountMinor, `payout:${id}`, now),
      ...postingStatements(db, { kind: 'wallet_reserve_payout', referenceId: id, memo: `Payout request ${id}`, entries: [
        { account: acct.walletAvailable(userId), currency: p.currency, amount: p.amountMinor },
        { account: acct.walletReservedPayout(userId), currency: p.currency, amount: -p.amountMinor },
      ] }, now),
      ...walletStatements(db, userId, p.currency, { available: -p.amountMinor, reservedPayout: p.amountMinor }),
      outboxStatement(db, 'PayoutRequested', id, { currency: p.currency, amount: p.amountMinor }, now),
    ]);
  } catch (e) {
    if (isConstraintError(e)) {
      const raced = await db.prepare('SELECT id, state, currency, requested_minor FROM payout_requests WHERE idempotency_key = ?').bind(key).first();
      if (raced) return raced;
      throw new DomainError('insufficient_wallet', 'Not enough available commission balance', 409);
    }
    throw e;
  }
  return { id, state: 'requested', currency: p.currency, requested_minor: p.amountMinor };
}

export async function payoutStatus(db: D1Database, userId: string) {
  const { results } = await db.prepare(`SELECT r.id, r.currency, r.requested_minor, r.state, r.payout_method, r.requested_at, t.bank_transfer_reference, t.transferred_at
      FROM payout_requests r LEFT JOIN payout_transfers t ON t.payout_request_id = r.id WHERE r.user_id = ? ORDER BY r.requested_at DESC`).bind(userId).all();
  return results;
}

/** Manual payouts are transferred on days 01-10 (ICT) of each month. */
export const inPayoutWindow = (nowMs: number) => Number(ictDate(nowMs).slice(8, 10)) <= 10;

export async function preparePayoutBatch(db: D1Database, keys: PiiKeyring, actor: string, windowMonth: string, nowMs = Date.now()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(windowMonth)) throw new DomainError('invalid_month', 'window_month must be YYYY-MM');
  const now = iso(nowMs);
  let batch = await db.prepare('SELECT * FROM payout_batches WHERE window_month = ?').bind(windowMonth).first<{ id: string; status: string }>();
  if (!batch) {
    try {
      await db.prepare(`INSERT INTO payout_batches (id, window_month, status, prepared_at) VALUES (?, ?, 'prepared', ?)`).bind(newId('pyb'), windowMonth, now).run();
    } catch (e) {
      if (!isConstraintError(e)) throw e;
    }
    batch = (await db.prepare('SELECT * FROM payout_batches WHERE window_month = ?').bind(windowMonth).first<{ id: string; status: string }>())!;
  }
  // Every open request made up to the moment of preparation joins this month's batch.
  await db.batch([
    db.prepare(`UPDATE payout_requests SET state = 'batched', batch_id = ?, updated_at = ? WHERE state = 'requested' AND requested_at <= ?`).bind(batch.id, now, now),
    decisionStatement(db, { actor, action: 'payouts.prepare_batch', decision: 'allow', reasons: ['BATCH_PREPARED'], policy: REFERRAL_POLICY_VERSION, resourceId: batch.id }, now),
    outboxStatement(db, 'PayoutBatchPrepared', batch.id, { windowMonth }, now),
  ]);
  const { results } = await db.prepare(`SELECT r.id, r.user_id, r.currency, r.requested_minor, r.payout_method, r.beneficiary_reference, r.state, u.display_name
      FROM payout_requests r JOIN users u ON u.id = r.user_id WHERE r.batch_id = ? ORDER BY r.requested_at`).bind(batch.id).all<{
    id: string; user_id: string; currency: string; requested_minor: number; payout_method: string; beneficiary_reference: string; state: string; display_name: string;
  }>();
  const items = [];
  for (const r of results) items.push({ ...r, beneficiary_reference: await decryptField(keys, r.beneficiary_reference) });
  return { batch_id: batch.id, window_month: windowMonth, status: batch.status, items };
}

export interface ManualTransfer {
  payoutRequestId: string;
  bankTransferReference: string;
  amountMinor: number;
  transferredAt: string;
  proofRef: string;
}

/** Record a transfer the operator made by hand. Requires proof, exact amount and the 01-10 window (A31). */
export async function recordManualTransfer(db: D1Database, actor: string, t: ManualTransfer, nowMs = Date.now()) {
  const now = iso(nowMs);
  const req = await db.prepare('SELECT * FROM payout_requests WHERE id = ?').bind(t.payoutRequestId)
    .first<{ id: string; user_id: string; currency: string; requested_minor: number; state: string; batch_id: string | null }>();
  if (!req) throw notFound('Payout request not found');
  const deny = async (reason: string, msg: string) => {
    await decisionStatement(db, { actor, action: 'payouts.record_manual_transfer', decision: 'deny', reasons: [reason], policy: REFERRAL_POLICY_VERSION, resourceId: req.id }, now).run();
    throw new DomainError(reason.toLowerCase(), msg, 409);
  };
  if (req.state === 'paid') return { status: 'already_paid' };
  if (req.state !== 'batched' || !req.batch_id) await deny('NOT_BATCHED', 'Prepare the monthly batch before recording transfers');
  if (!inPayoutWindow(nowMs)) await deny('OUTSIDE_PAYOUT_WINDOW', 'Manual transfers are recorded on days 01-10 (ICT) only');
  if (t.amountMinor !== req.requested_minor) await deny('AMOUNT_MISMATCH', `Transfer must equal the requested ${req.requested_minor}`);
  if (!t.bankTransferReference.trim() || !t.proofRef.trim()) await deny('PROOF_REQUIRED', 'bank_transfer_reference and proof_ref are required');
  if (Number.isNaN(Date.parse(t.transferredAt)) || Date.parse(t.transferredAt) > nowMs) await deny('INVALID_TRANSFER_TIME', 'transferred_at must be a past ISO timestamp');
  const res = await db.prepare('SELECT id FROM wallet_reservations WHERE payout_request_id = ?').bind(req.id).first<{ id: string }>();
  if (!res) throw new DomainError('reservation_missing', 'Payout reservation missing', 500);
  try {
    await db.batch([
      db.prepare(`INSERT INTO payout_transfers (id, payout_batch_id, payout_request_id, currency, amount_minor, bank_transfer_reference, proof_ref, transferred_at, recorded_by, status, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reconciled', ?)`)
        .bind(newId('pyt'), req.batch_id, req.id, req.currency, t.amountMinor, t.bankTransferReference.trim(), t.proofRef.trim(), t.transferredAt, actor, now),
      db.prepare(`INSERT INTO reservation_closures (reservation_id, outcome, closed_at) VALUES (?, 'paid', ?)`).bind(res.id, now),
      db.prepare(`UPDATE payout_requests SET state = 'paid', updated_at = ? WHERE id = ? AND state = 'batched'`).bind(now, req.id),
      ...postingStatements(db, { kind: 'payout_paid', referenceId: req.id, memo: `Manual transfer ${t.bankTransferReference.trim()}`, entries: [
        { account: acct.walletReservedPayout(req.user_id), currency: req.currency, amount: t.amountMinor },
        { account: acct.payoutsCash(), currency: req.currency, amount: -t.amountMinor },
      ] }, now),
      ...walletStatements(db, req.user_id, req.currency, { reservedPayout: -t.amountMinor, paid: t.amountMinor }),
      decisionStatement(db, { actor, action: 'payouts.record_manual_transfer', decision: 'allow', reasons: ['PROOF_RECORDED'], policy: REFERRAL_POLICY_VERSION, resourceId: req.id }, now),
      outboxStatement(db, 'PayoutTransferReconciled', req.id, { reference: t.bankTransferReference.trim() }, now),
    ]);
  } catch (e) {
    if (isConstraintError(e)) throw new DomainError('duplicate_transfer', 'This payout or bank reference was already recorded', 409);
    throw e;
  }
  return { status: 'paid' };
}

/** A failed manual transfer returns the funds to the available balance. */
export async function failPayout(db: D1Database, actor: string, payoutRequestId: string, reason: string, nowMs = Date.now()) {
  const now = iso(nowMs);
  const req = await db.prepare('SELECT * FROM payout_requests WHERE id = ?').bind(payoutRequestId).first<{ id: string; user_id: string; currency: string; requested_minor: number; state: string }>();
  if (!req) throw notFound('Payout request not found');
  const res = await db.prepare('SELECT id FROM wallet_reservations WHERE payout_request_id = ?').bind(req.id).first<{ id: string }>();
  if (!res || !['requested', 'batched'].includes(req.state)) return { status: req.state };
  try {
    await db.batch([
      db.prepare(`INSERT INTO reservation_closures (reservation_id, outcome, closed_at) VALUES (?, 'failed', ?)`).bind(res.id, now),
      db.prepare(`UPDATE payout_requests SET state = 'failed', updated_at = ? WHERE id = ? AND state IN ('requested', 'batched')`).bind(now, req.id),
      guardStatement(db, `EXISTS (SELECT 1 FROM payout_requests WHERE id = ? AND state = 'failed')`, req.id),
      ...postingStatements(db, { kind: 'payout_failed', referenceId: req.id, memo: `Payout failed: ${reason}`, entries: [
        { account: acct.walletReservedPayout(req.user_id), currency: req.currency, amount: req.requested_minor },
        { account: acct.walletAvailable(req.user_id), currency: req.currency, amount: -req.requested_minor },
      ] }, now),
      ...walletStatements(db, req.user_id, req.currency, { reservedPayout: -req.requested_minor, available: req.requested_minor }),
      decisionStatement(db, { actor, action: 'payouts.fail', decision: 'allow', reasons: [reason || 'TRANSFER_FAILED'], policy: REFERRAL_POLICY_VERSION, resourceId: req.id }, now),
    ]);
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    // Lost a race (e.g. the transfer was recorded meanwhile): report the real state.
    const now2 = await db.prepare('SELECT state FROM payout_requests WHERE id = ?').bind(req.id).first<{ state: string }>();
    return { status: now2?.state ?? 'unknown' };
  }
  return { status: 'failed' };
}
