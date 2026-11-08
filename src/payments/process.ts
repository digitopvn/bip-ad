// Turns verified provider events into settlements/refunds. Event ids are recorded with
// UNIQUE(provider, event_id) so a replayed webhook is acknowledged without side effects.
import { type Provider, flagCaptureForReview, getIntent, refund, resolvePaymentReview, settle } from '../domain/bidding';
import type { Config } from '../domain/config';
import { isConstraintError } from '../domain/errors';
import { newId } from '../lib/ids';
import { iso } from '../lib/time';
import { type PayPalEvent, refundedCaptureId, toMinorUSD } from './paypal';
import { type SePayIpn, vndMinor } from './sepay';

export interface NormalizedEvent {
  provider: Provider;
  eventId: string;
  eventType: string;
  action: 'capture_completed' | 'refund' | 'chargeback' | 'ignore';
  intentId?: string;
  providerPaymentId?: string;
  currency?: string;
  amountMinor?: number;
  /** Simulated money (PAYMENT_MODE=simulated): kept apart from real cash and never payable. */
  isTest?: boolean;
}

export function normalizePayPal(e: PayPalEvent): NormalizedEvent {
  const base = { provider: 'paypal' as const, eventId: e.id, eventType: e.event_type };
  const amount = e.resource.amount ? toMinorUSD(e.resource.amount.value) : undefined;
  switch (e.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED':
      if (e.resource.status !== 'COMPLETED' || !e.resource.amount) return { ...base, action: 'ignore' };
      return { ...base, action: 'capture_completed', intentId: e.resource.custom_id ?? e.resource.invoice_id, providerPaymentId: e.resource.id,
        currency: e.resource.amount.currency_code, amountMinor: amount };
    case 'PAYMENT.CAPTURE.REFUNDED':
      // The resource is the refund; its amount is what was refunded (may be partial).
      return { ...base, action: 'refund', providerPaymentId: refundedCaptureId(e) ?? undefined, amountMinor: amount };
    case 'PAYMENT.CAPTURE.REVERSED':
      // Resolve the capture through links[rel=up] when the resource is a refund-type object.
      return { ...base, action: 'chargeback', providerPaymentId: refundedCaptureId(e) ?? e.resource.id };
    default:
      // PENDING / DENIED and anything else never confirm a bid.
      return { ...base, action: 'ignore' };
  }
}

export function normalizeSePay(e: SePayIpn): NormalizedEvent {
  const txId = e.transaction.transaction_id ?? e.transaction.id;
  const base = { provider: 'sepay' as const, eventId: `${e.notification_type}:${txId ?? e.order.order_id ?? e.timestamp}`, eventType: e.notification_type };
  if (e.notification_type === 'ORDER_PAID') {
    return { ...base, action: 'capture_completed', intentId: e.order.order_invoice_number, providerPaymentId: txId,
      currency: e.transaction.transaction_currency ?? e.order.order_currency ?? 'VND', amountMinor: vndMinor(e.transaction.transaction_amount ?? e.order.order_amount) };
  }
  if (e.notification_type === 'TRANSACTION_VOID') return { ...base, action: 'refund', providerPaymentId: txId };
  return { ...base, action: 'ignore' };
}

/** Statuses after which a redelivered event is acknowledged without being processed again. */
const FINAL = (status: string) => status !== 'received' && status !== 'failed' && status !== 'retry';

/**
 * Apply a verified provider event at most once in effect. The event row is a delivery log, not a
 * lock: a redelivery of an event that is still `received` (crashed mid-way), `failed` or `retry`
 * is processed again, which is safe because settle/refund are idempotent by their own UNIQUE keys.
 * `retry` (e.g. a refund that arrived before its capture) and `failed` ask the provider to redeliver.
 */
export async function processEvent(db: D1Database, cfg: Config, ev: NormalizedEvent, nowMs = Date.now()): Promise<{ status: string; retry?: boolean }> {
  try {
    await db.prepare(`INSERT INTO webhook_events (id, provider, event_id, event_type, signature_verified, status, received_at) VALUES (?, ?, ?, ?, 1, 'received', ?)`)
      .bind(newId('whk'), ev.provider, ev.eventId, ev.eventType, iso(nowMs)).run();
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    const prior = await db.prepare('SELECT status FROM webhook_events WHERE provider = ? AND event_id = ?').bind(ev.provider, ev.eventId).first<{ status: string }>();
    if (prior && FINAL(prior.status)) return { status: 'replayed' };
  }
  let status: string;
  try {
    status = await apply(db, cfg, ev, nowMs);
  } catch (e) {
    console.error('webhook processing failed', ev.provider, ev.eventId, e);
    await db.prepare('UPDATE webhook_events SET status = ?, detail = ? WHERE provider = ? AND event_id = ?')
      .bind('failed', String(e instanceof Error ? e.message : e).slice(0, 500), ev.provider, ev.eventId).run().catch(() => undefined);
    return { status: 'failed', retry: true };
  }
  await db.prepare('UPDATE webhook_events SET status = ? WHERE provider = ? AND event_id = ?').bind(status, ev.provider, ev.eventId).run();
  return status === 'retry' ? { status, retry: true } : { status };
}

async function apply(db: D1Database, cfg: Config, ev: NormalizedEvent, nowMs: number): Promise<string> {
  if (ev.action === 'capture_completed' && ev.intentId && ev.providerPaymentId && Number.isSafeInteger(ev.amountMinor)) {
    const intent = await getIntent(db, ev.intentId);
    if (intent && intent.provider !== ev.provider) {
      await flagCaptureForReview(db, { intentId: ev.intentId, provider: ev.provider, providerPaymentId: ev.providerPaymentId, currency: ev.currency!, cashMinor: ev.amountMinor!, confirmedAtMs: nowMs, isTest: ev.isTest }, null, 'intent_provider_mismatch');
      return 'review:intent_provider_mismatch';
    }
    const r = await settle(db, cfg, { intentId: ev.intentId, provider: ev.provider, providerPaymentId: ev.providerPaymentId, currency: ev.currency!, cashMinor: ev.amountMinor!, confirmedAtMs: nowMs, isTest: ev.isTest });
    return r.status === 'rejected' ? `review:${r.reason}` : r.status;
  }
  if ((ev.action === 'refund' || ev.action === 'chargeback') && ev.providerPaymentId) {
    const r = await refund(db, { provider: ev.provider, providerPaymentId: ev.providerPaymentId, kind: ev.action, atMs: nowMs, amountMinor: ev.amountMinor, eventRef: ev.eventId });
    if (r.status !== 'unknown') return r.status;
    // A reversal of a capture we only hold as a review (never settled) needs no ledger change, but
    // the review must close so the operator can no longer settle money that was returned.
    const { results: open } = await db.prepare(`SELECT id FROM payment_reviews WHERE provider = ? AND provider_payment_id = ? AND kind = 'capture'`)
      .bind(ev.provider, ev.providerPaymentId).all<{ id: string }>();
    // Otherwise it may have arrived before its capture: ask the provider to redeliver.
    if (!open.length) return 'retry';
    for (const rv of open) await resolvePaymentReview(db, cfg, 'system:provider', rv.id, 'dismiss', `${ev.action} by provider`, nowMs);
    return 'reviewed_capture_reversed';
  }
  return 'ignored';
}

/**
 * Test-mode payment simulator (PAYMENT_MODE=simulated only). Builds the same normalized event a
 * verified provider webhook would produce, so the settlement path is identical. No money moves.
 */
export async function simulatePayment(db: D1Database, cfg: Config, intentId: string, provider: Provider, nowMs = Date.now()) {
  if (cfg.paymentMode !== 'simulated') throw new Error('simulator disabled outside simulated mode');
  const intent = await getIntent(db, intentId);
  if (!intent) throw new Error('unknown intent');
  const due = intent.quote_minor - intent.wallet_applied_minor;
  const sim = `sim_${intentId}`;
  return processEvent(db, cfg, { provider, eventId: `sim:${intentId}`, eventType: 'SIMULATED_CAPTURE', action: 'capture_completed', intentId, providerPaymentId: sim, currency: intent.quote_currency, amountMinor: due, isTest: true }, nowMs);
}
