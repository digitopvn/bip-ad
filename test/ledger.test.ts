import { describe, expect, it } from 'vitest';
import { applyWallet, beginCheckout, quote, refund, releaseWallet, settle } from '../src/domain/bidding';
import { DomainError } from '../src/domain/errors';
import { attributeSignup, getOrCreateReferralCode } from '../src/domain/referrals';
import { failPayout, piiKeys, preparePayoutBatch, recordManualTransfer, requestPayout, vestCommissions, walletBalances } from '../src/domain/wallet';
import { reconcile } from '../src/mcp/operator-server';
import { newId } from '../src/lib/ids';
import { DAY_MS } from '../src/lib/time';
import { E, bid, cfg, db, ledgerBalancedEverywhere, makeProduct, makeUser, realCfg } from './helpers';

const bal = async (u: string, cur = 'USD') => (await walletBalances(db(), u)).find(b => b.currency === cur);

/** Referrer R refers buyer B (B's account attributed at signup). */
async function referredPair() {
  const r = await makeUser('Referrer');
  const b = await makeUser('Buyer');
  const code = await getOrCreateReferralCode(db(), r);
  expect(await attributeSignup(db(), cfg(), b, code, Date.now() - 1000)).toBe('attributed');
  return { r, b };
}

describe('revenue split and referral commission', () => {
  it('cash bid without referral: 80% ads, 0% commission, 20% platform', async () => {
    const u = await makeUser();
    const p = await makeProduct(u, 'Split NoRef');
    const id = await bid(u, p, 'daily', 10000, Date.now());
    const c = await db().prepare('SELECT gross_minor, ads_minor, commission_minor, platform_minor FROM bid_contributions WHERE bid_intent_id = ?').bind(id).first();
    expect(c).toEqual({ gross_minor: 10000, ads_minor: 8000, commission_minor: 0, platform_minor: 2000 });
  });

  it('A27: referred buyer first cash bid → 5% commission accrued once (pending), available after hold; ads stay 80%', async () => {
    const { r, b } = await referredPair();
    const p = await makeProduct(b, 'Split Ref');
    const t = Date.now();
    const id = await bid(b, p, 'weekly', 10000, t);
    const c = await db().prepare('SELECT ads_minor, commission_minor, platform_minor FROM bid_contributions WHERE bid_intent_id = ?').bind(id).first();
    expect(c).toEqual({ ads_minor: 8000, commission_minor: 500, platform_minor: 1500 });
    expect(await bal(r)).toMatchObject({ pending_minor: 500, available_minor: 0 });
    // A25: more bids from the same referred buyer never add referrals or commission.
    for (let i = 0; i < 4; i++) await bid(b, p, 'weekly', 2000, t + (i + 1) * 1000);
    const n = await db().prepare('SELECT COUNT(*) AS n FROM successful_referrals WHERE referrer_user_id = ?').bind(r).first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(await bal(r)).toMatchObject({ pending_minor: 500 });
    // Hold period ends → available, referral counted as successful (vested).
    await vestCommissions(db(), t + 31 * DAY_MS);
    await vestCommissions(db(), t + 32 * DAY_MS); // idempotent
    expect(await bal(r)).toMatchObject({ pending_minor: 0, available_minor: 500 });
    const sr = await db().prepare('SELECT status FROM successful_referrals WHERE referrer_user_id = ?').bind(r).first<{ status: string }>();
    expect(sr!.status).toBe('vested');
    expect(await ledgerBalancedEverywhere()).toBe(true);
  });

  it('commission is earned only on the referred buyer\'s first external-cash bid; wallet-funded bids earn none', async () => {
    const { r, b } = await referredPair();
    // B earns its own commission by referring C, so B can pay a bid from its wallet.
    const c = await makeUser('Buyer of B');
    expect(await attributeSignup(db(), cfg(), c, await getOrCreateReferralCode(db(), b), Date.now() - 1000)).toBe('attributed');
    await bid(c, await makeProduct(c, `Fund ${newId('f')}`), 'monthly', 10000, Date.now() - 40 * DAY_MS);
    await vestCommissions(db(), Date.now());
    expect(await bal(b)).toMatchObject({ available_minor: 500 });
    const commissionOf = async (intentId: string) =>
      (await db().prepare('SELECT commission_minor FROM bid_contributions WHERE bid_intent_id = ?').bind(intentId).first<{ commission_minor: number }>())!.commission_minor;
    const p = await makeProduct(b, 'First Cash Only');
    const t = Date.now();
    // A wallet-only bid is not an external-cash bid: no commission, and the referral is not used up.
    expect(await commissionOf(await bid(b, p, 'daily', 500, t, 'paypal', 500))).toBe(0);
    expect((await bal(r))?.pending_minor ?? 0).toBe(0);
    // The first external-cash bid earns 5%; the second earns nothing.
    expect(await commissionOf(await bid(b, p, 'daily', 10000, t + 1000))).toBe(500);
    expect(await commissionOf(await bid(b, p, 'daily', 10000, t + 2000))).toBe(0);
    const n = await db().prepare('SELECT COUNT(*) AS n FROM referral_commissions WHERE referrer_user_id = ?').bind(r).first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(await bal(r)).toMatchObject({ pending_minor: 500 });
    expect(await ledgerBalancedEverywhere()).toBe(true);
  });

  it('A26: self-referral is rejected at attribution; no commission', async () => {
    const r = await makeUser('Self', 'same@example.test');
    const alt = await makeUser('Alt', 'SAME@example.test');
    const code = await getOrCreateReferralCode(db(), r);
    expect(await attributeSignup(db(), cfg(), r, code, Date.now())).toBe('rejected');
    expect(await attributeSignup(db(), cfg(), alt, code, Date.now())).toBe('rejected');
  });

  it('A32: refund of the qualifying bid claws back the commission and the referral', async () => {
    const { r, b } = await referredPair();
    const p = await makeProduct(b, 'Clawback');
    const { intent } = await quote(db(), cfg(), b, { productId: p, board: 'daily', rankUnits: 4000, currency: 'USD', idempotencyKey: newId('q') });
    await beginCheckout(db(), cfg(), b, intent.id, 'paypal');
    await settle(db(), cfg(), { intentId: intent.id, provider: 'paypal', providerPaymentId: 'CAP-CLAW-' + intent.id, currency: 'USD', cashMinor: 4000, confirmedAtMs: Date.now() });
    expect(await bal(r)).toMatchObject({ pending_minor: 200 });
    await refund(db(), { provider: 'paypal', providerPaymentId: 'CAP-CLAW-' + intent.id, kind: 'chargeback', atMs: Date.now() });
    expect(await bal(r)).toMatchObject({ pending_minor: 0 });
    const sr = await db().prepare('SELECT status FROM successful_referrals WHERE referrer_user_id = ?').bind(r).first<{ status: string }>();
    expect(sr!.status).toBe('clawed_back');
    expect(await ledgerBalancedEverywhere()).toBe(true);
  });
});

/** Give user `u` an available USD wallet balance of 500 via a vested referral commission. */
async function fundedWallet() {
  const { r, b } = await referredPair();
  const p = await makeProduct(b, `Fund ${newId('f')}`);
  const t = Date.now() - 40 * DAY_MS;
  await bid(b, p, 'monthly', 10000, t);
  await vestCommissions(db(), Date.now());
  expect(await bal(r)).toMatchObject({ available_minor: 500 });
  return r;
}

describe('commission wallet', () => {
  it('A28: full wallet bid → one contribution, no cash receipt, no commission, ads 80%', async () => {
    const r = await fundedWallet();
    const p = await makeProduct(r, 'Wallet Full');
    const id = await bid(r, p, 'daily', 500, Date.now(), 'paypal', 500);
    const pay = await db().prepare('SELECT provider, cash_minor, wallet_minor FROM payments WHERE bid_intent_id = ?').bind(id).first();
    expect(pay).toEqual({ provider: 'wallet', cash_minor: 0, wallet_minor: 500 });
    const c = await db().prepare('SELECT ads_minor, commission_minor, platform_minor FROM bid_contributions WHERE bid_intent_id = ?').bind(id).first();
    expect(c).toEqual({ ads_minor: 400, commission_minor: 0, platform_minor: 100 });
    expect(await bal(r)).toMatchObject({ available_minor: 0, reserved_for_bid_minor: 0 });
    const cash = await db().prepare(`SELECT COUNT(*) AS n FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.txn_id WHERE t.reference_id = ? AND e.account LIKE 'asset:cash:%'`).bind(id).first<{ n: number }>();
    expect(cash!.n).toBe(0);
    expect((await reconcile(db())).wallet_drift).toEqual([]);
  });

  it('A29: partial wallet + failed provider payment → no rank, reservation released exactly once', async () => {
    const r = await fundedWallet();
    const p = await makeProduct(r, 'Wallet Partial');
    const { intent } = await quote(db(), cfg(), r, { productId: p, board: 'daily', rankUnits: 2000, currency: 'USD', idempotencyKey: newId('q') });
    await beginCheckout(db(), cfg(), r, intent.id, 'paypal', { walletMinor: 300 });
    expect(await bal(r)).toMatchObject({ available_minor: 200, reserved_for_bid_minor: 300 });
    expect(await releaseWallet(db(), intent.id, 'provider failed')).toBe(true);
    expect(await releaseWallet(db(), intent.id, 'retry')).toBe(false);
    expect(await bal(r)).toMatchObject({ available_minor: 500, reserved_for_bid_minor: 0 });
    // A late capture after release cannot settle (the wallet part is gone) but is never silently
    // kept: the intent moves to needs_review and the money is recorded for the operator.
    const s = await settle(db(), cfg(), { intentId: intent.id, provider: 'paypal', providerPaymentId: 'CAP-late', currency: 'USD', cashMinor: 1700, confirmedAtMs: Date.now() });
    expect(s).toEqual({ status: 'rejected', reason: 'wallet_reservation_missing' });
    expect((await db().prepare('SELECT status FROM bid_intents WHERE id = ?').bind(intent.id).first<{ status: string }>())!.status).toBe('needs_review');
    const rv = await db().prepare(`SELECT kind, amount_minor, status FROM payment_reviews WHERE bid_intent_id = ?`).bind(intent.id).first();
    expect(rv).toEqual({ kind: 'capture', amount_minor: 1700, status: 'open' });
    expect(await db().prepare('SELECT 1 FROM bid_contributions WHERE bid_intent_id = ?').bind(intent.id).first()).toBeNull();
    expect((await reconcile(db())).wallet_drift).toEqual([]);
  });

  it('wallet funds cannot be applied once checkout started (the provider amount is fixed)', async () => {
    const r = await fundedWallet();
    const p = await makeProduct(r, 'Wallet Locked');
    const { intent } = await quote(db(), cfg(), r, { productId: p, board: 'daily', rankUnits: 2000, currency: 'USD', idempotencyKey: newId('q') });
    await beginCheckout(db(), cfg(), r, intent.id, 'paypal');
    await expect(applyWallet(db(), r, intent.id, 300)).rejects.toMatchObject({ code: 'intent_locked' });
    expect(await bal(r)).toMatchObject({ available_minor: 500, reserved_for_bid_minor: 0 });
    // The full cash capture still settles normally.
    const s = await settle(db(), cfg(), { intentId: intent.id, provider: 'paypal', providerPaymentId: 'CAP-' + intent.id, currency: 'USD', cashMinor: 2000, confirmedAtMs: Date.now() });
    expect(s.status).toBe('settled');
  });

  it('A30: concurrent payout request and wallet bid for the same $5 → only one reserves it', async () => {
    const r = await fundedWallet();
    const p = await makeProduct(r, 'Race');
    const { intent } = await quote(db(), cfg(), r, { productId: p, board: 'daily', rankUnits: 500, currency: 'USD', idempotencyKey: newId('q') });
    const lowMin = realCfg();
    const results = await Promise.allSettled([
      applyWallet(db(), r, intent.id, 500),
      requestPayout(db(), lowMin, piiKeys(E), r, { currency: 'USD', amountMinor: 500, payoutMethod: 'paypal', beneficiaryReference: 'me@paypal.test', idempotencyKey: newId('p') }),
    ]);
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    const rej = results.find(x => x.status === 'rejected') as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(DomainError);
    const b = (await bal(r))!;
    expect(b.available_minor).toBe(0);
    expect(b.reserved_for_bid_minor + b.reserved_for_payout_minor).toBe(500);
    expect((await reconcile(db())).wallet_drift).toEqual([]);
  });
});

describe('manual payouts (01-10 window)', () => {
  const inWindow = Date.parse('2031-05-04T05:00:00Z'); // 4 May, ICT
  const outWindow = Date.parse('2031-05-15T05:00:00Z');

  it('A31: request → batch → transfer recorded only with proof, exact amount, inside 01-10', async () => {
    const r = await fundedWallet();
    const lowMin = realCfg();
    const req = await requestPayout(db(), lowMin, piiKeys(E), r, { currency: 'USD', amountMinor: 400, payoutMethod: 'bank_transfer', beneficiaryReference: 'VCB 0123456789 NGUYEN A', idempotencyKey: newId('p') }) as { id: string };
    expect(await bal(r)).toMatchObject({ available_minor: 100, reserved_for_payout_minor: 400 });
    // Beneficiary details are encrypted at rest.
    const raw = await db().prepare('SELECT beneficiary_reference FROM payout_requests WHERE id = ?').bind(req.id).first<{ beneficiary_reference: string }>();
    expect(raw!.beneficiary_reference).not.toContain('0123456789');
    expect(raw!.beneficiary_reference).toMatch(/^v2\.[0-9a-f]{12}\./);
    expect(raw!.beneficiary_reference).toMatch(/^v2\.[0-9a-f]{12}\./);

    const batch = await preparePayoutBatch(db(), piiKeys(E), 'operator:test', '2031-05', inWindow);
    expect(batch.items.find(i => i.id === req.id)?.beneficiary_reference).toBe('VCB 0123456789 NGUYEN A');
    const t = { payoutRequestId: req.id, bankTransferReference: `FT${req.id}`, amountMinor: 400, transferredAt: new Date(inWindow - 3600_000).toISOString(), proofRef: 'vault://proofs/1' };
    await expect(recordManualTransfer(db(), 'operator:test', t, outWindow)).rejects.toThrow(/01-10/);
    await expect(recordManualTransfer(db(), 'operator:test', { ...t, amountMinor: 399 }, inWindow)).rejects.toThrow(/equal/);
    await expect(recordManualTransfer(db(), 'operator:test', { ...t, proofRef: ' ' }, inWindow)).rejects.toThrow(/proof/);
    expect(await recordManualTransfer(db(), 'operator:test', t, inWindow)).toEqual({ status: 'paid' });
    expect(await recordManualTransfer(db(), 'operator:test', t, inWindow)).toEqual({ status: 'already_paid' });
    expect(await bal(r)).toMatchObject({ reserved_for_payout_minor: 0, paid_minor: 400, available_minor: 100 });
    const denials = await db().prepare(`SELECT COUNT(*) AS n FROM decision_logs WHERE resource_id = ? AND decision = 'deny'`).bind(req.id).first<{ n: number }>();
    expect(denials!.n).toBe(3);
    expect(await ledgerBalancedEverywhere()).toBe(true);
  });

  it('failed transfer returns funds; minimum payout enforced', async () => {
    const r = await fundedWallet();
    await expect(requestPayout(db(), { ...realCfg(), minPayout: cfg().minPayout }, piiKeys(E), r, { currency: 'USD', amountMinor: 500, payoutMethod: 'paypal', beneficiaryReference: 'x@y.z', idempotencyKey: newId('p') })).rejects.toThrow(/Minimum payout/);
    const lowMin = realCfg();
    const req = await requestPayout(db(), lowMin, piiKeys(E), r, { currency: 'USD', amountMinor: 500, payoutMethod: 'paypal', beneficiaryReference: 'x@y.z', idempotencyKey: newId('p') }) as { id: string };
    await failPayout(db(), 'operator:test', req.id, 'BANK_REJECTED');
    await failPayout(db(), 'operator:test', req.id, 'again');
    expect(await bal(r)).toMatchObject({ available_minor: 500, reserved_for_payout_minor: 0 });
    expect((await reconcile(db())).balanced).toBe(true);
  });
});
