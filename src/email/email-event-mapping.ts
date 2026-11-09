// Maps one domain event (outbox_events row) to the emails it causes. Pure reads: the projector
// writes the resulting rows. Data is looked up at projection time, right after the event.
import type { Board } from '../domain/config';
import type { BoardCode, EmailKind, EmailMessageData } from './email-message-types';
import { mapLockResults } from './email-lock-results-mapping';
import { type EmailDraft, type MappingContext, type MappingResult, type OutboxEvent, type Payload, parsePayload, productUrl } from './email-projection-types';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Operator decisions carry `reason`; automated ones carry `reasons` (policy codes). */
function decisionReason(p: Payload): string {
  if (typeof p.reason === 'string') return p.reason.trim();
  if (Array.isArray(p.reasons)) return p.reasons.filter((r): r is string => typeof r === 'string').join(', ');
  return '';
}

async function draftFor(ctx: MappingContext, userId: string, kind: EmailKind, dedupeKey: string, build: (displayName: string) => EmailMessageData): Promise<EmailDraft[]> {
  const name = await ctx.displayName(userId);
  if (name === null) {
    console.warn(`email: user ${userId} not found for ${dedupeKey}`);
    return [];
  }
  return [{ userId, kind, dedupeKey, data: build(name) }];
}

async function productDecision(ctx: MappingContext, e: OutboxEvent, p: Payload): Promise<EmailDraft[]> {
  const product = await ctx.db.prepare('SELECT owner_id, name, slug, status FROM products WHERE id = ?').bind(e.aggregate_id)
    .first<{ owner_id: string; name: string; slug: string; status: string }>();
  if (!product) return [];
  // A rejection leaves a published (or suspended) product live as it was: only its pending changes were rejected.
  const outcome = e.event_type === 'ProductApproved' ? 'published'
    : e.event_type === 'ProductSuspended' ? 'suspended'
    : product.status === 'published' || product.status === 'suspended' ? 'changes_rejected' : 'rejected';
  // Approval reasons are internal policy codes (e.g. AUTO_SCREEN_PASSED); only negative outcomes explain themselves.
  const reason = outcome === 'published' ? '' : decisionReason(p);
  return draftFor(ctx, product.owner_id, 'product_decision', `evt:${e.id}`, displayName => ({
    kind: 'product_decision', displayName, productName: product.name, productUrl: productUrl(ctx.origin, product.slug), outcome, reason,
  }));
}

async function bidReceipt(ctx: MappingContext, e: OutboxEvent, p: Payload): Promise<EmailDraft[]> {
  const r = await ctx.db.prepare(`SELECT i.owner_id, i.board, i.rank_units, i.quote_currency, pr.name, pr.slug, pay.provider, pay.confirmed_at
      FROM bid_intents i JOIN products pr ON pr.id = i.product_id LEFT JOIN payments pay ON pay.bid_intent_id = i.id WHERE i.id = ?`).bind(e.aggregate_id)
    .first<{ owner_id: string; board: Board; rank_units: number; quote_currency: string; name: string; slug: string; provider: string | null; confirmed_at: string | null }>();
  if (!r) return [];
  const currency = typeof p.currency === 'string' ? p.currency : r.quote_currency;
  const rawProvider = typeof p.provider === 'string' ? p.provider : r.provider;
  const provider = rawProvider === 'paypal' || rawProvider === 'sepay' || rawProvider === 'wallet' ? rawProvider : 'wallet';
  return draftFor(ctx, r.owner_id, 'bid_receipt', `evt:${e.id}`, displayName => ({
    kind: 'bid_receipt', displayName, productName: r.name, productUrl: productUrl(ctx.origin, r.slug), board: r.board as BoardCode, rankUnits: r.rank_units,
    cash: { currency, minor: num(p.cash) }, wallet: { currency, minor: num(p.wallet) }, provider, test: p.test === true,
    bidIntentId: e.aggregate_id, confirmedAt: r.confirmed_at ?? e.created_at,
  }));
}

async function bidReversed(ctx: MappingContext, e: OutboxEvent): Promise<EmailDraft[]> {
  const r = await ctx.db.prepare(`SELECT i.id AS intent_id, i.owner_id, i.board, pr.name, pr.slug, pay.currency, pay.cash_minor + pay.wallet_minor AS amount
      FROM payments pay JOIN bid_intents i ON i.id = pay.bid_intent_id JOIN products pr ON pr.id = i.product_id WHERE pay.id = ?`).bind(e.aggregate_id)
    .first<{ intent_id: string; owner_id: string; board: Board; name: string; slug: string; currency: string; amount: number }>();
  if (!r) return [];
  return draftFor(ctx, r.owner_id, 'bid_reversed', `evt:${e.id}`, displayName => ({
    kind: 'bid_reversed', displayName, productName: r.name, productUrl: productUrl(ctx.origin, r.slug), board: r.board as BoardCode,
    reversal: e.event_type === 'RefundRecorded' ? 'refund' : 'chargeback', amount: { currency: r.currency, minor: r.amount }, bidIntentId: r.intent_id,
  }));
}

async function commissionAvailable(ctx: MappingContext, e: OutboxEvent): Promise<EmailDraft[]> {
  const c = await ctx.db.prepare('SELECT referrer_user_id, currency, commission_minor FROM referral_commissions WHERE id = ?').bind(e.aggregate_id)
    .first<{ referrer_user_id: string; currency: string; commission_minor: number }>();
  // A commission rounded to zero still vests, but there is nothing to announce.
  if (!c || c.commission_minor <= 0) return [];
  return draftFor(ctx, c.referrer_user_id, 'commission_available', `evt:${e.id}`, displayName => ({
    kind: 'commission_available', displayName, amount: { currency: c.currency, minor: c.commission_minor }, walletUrl: `${ctx.origin}/account/wallet`,
  }));
}

async function payoutPaid(ctx: MappingContext, e: OutboxEvent, p: Payload): Promise<EmailDraft[]> {
  const r = await ctx.db.prepare(`SELECT q.user_id, q.currency, q.requested_minor, q.payout_method, t.amount_minor, t.bank_transfer_reference
      FROM payout_requests q LEFT JOIN payout_transfers t ON t.payout_request_id = q.id WHERE q.id = ?`).bind(e.aggregate_id)
    .first<{ user_id: string; currency: string; requested_minor: number; payout_method: string; amount_minor: number | null; bank_transfer_reference: string | null }>();
  if (!r) return [];
  const reference = r.bank_transfer_reference ?? (typeof p.reference === 'string' ? p.reference : '');
  return draftFor(ctx, r.user_id, 'payout_paid', `evt:${e.id}`, displayName => ({
    kind: 'payout_paid', displayName, amount: { currency: r.currency, minor: r.amount_minor ?? r.requested_minor }, method: r.payout_method, reference,
    walletUrl: `${ctx.origin}/account/wallet`,
  }));
}

/** Emails caused by one event. Event types without an email map to []. */
export async function mapEvent(ctx: MappingContext, e: OutboxEvent): Promise<MappingResult> {
  const p = parsePayload(e.payload_json);
  switch (e.event_type) {
    case 'UserCreated':
      return draftFor(ctx, e.aggregate_id, 'welcome', `welcome:${e.aggregate_id}`, displayName => ({ kind: 'welcome', displayName }));
    case 'ProductApproved':
    case 'ProductRejected':
    case 'ProductSuspended':
      return productDecision(ctx, e, p);
    case 'PaymentConfirmed':
      return bidReceipt(ctx, e, p);
    case 'RefundRecorded':
    case 'ChargebackRecorded':
      return bidReversed(ctx, e);
    case 'BoardSnapshotFrozen':
      return mapLockResults(ctx, e, p);
    case 'CommissionAvailable':
      return commissionAvailable(ctx, e);
    case 'PayoutTransferReconciled':
      return payoutPaid(ctx, e, p);
    default:
      return [];
  }
}
