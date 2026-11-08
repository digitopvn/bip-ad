// Double-entry ledger. Postings are built as D1 statements so callers put them in the same
// db.batch() as the business rows they account for: either everything commits or nothing does.
import { newId } from '../lib/ids';
import { DomainError } from './errors';

export interface Entry {
  account: string;
  currency: string;
  /** > 0 debit, < 0 credit. */
  amount: number;
}

export interface Posting {
  kind: string;
  /** (kind, referenceId) is UNIQUE: re-posting the same business event aborts the batch. */
  referenceId: string;
  memo: string;
  entries: Entry[];
}

/** Ledger account names. Wallet accounts are liabilities owed to the user (credit-normal). */
export const acct = {
  cash: (provider: string) => `asset:cash:${provider}`,
  payoutsCash: () => 'asset:cash:bank_payouts',
  clawbackReceivable: (u: string) => `asset:clawback_receivable:${u}`,
  adsPending: (board: string) => `liability:ads_pending:${board}`,
  adsFund: (board: string) => `liability:ads_fund:${board}`,
  walletPending: (u: string) => `liability:wallet:${u}:pending`,
  walletAvailable: (u: string) => `liability:wallet:${u}:available`,
  walletReservedBid: (u: string) => `liability:wallet:${u}:reserved_bid`,
  walletReservedPayout: (u: string) => `liability:wallet:${u}:reserved_payout`,
  platformRevenue: () => 'revenue:platform',
};

export function assertBalanced(entries: Entry[]) {
  const sums = new Map<string, number>();
  for (const e of entries) {
    if (!Number.isSafeInteger(e.amount)) throw new DomainError('ledger_invalid', `Non-integer amount on ${e.account}`);
    sums.set(e.currency, (sums.get(e.currency) ?? 0) + e.amount);
  }
  for (const [cur, s] of sums) if (s !== 0) throw new DomainError('ledger_unbalanced', `Posting unbalanced in ${cur} by ${s}`);
}

export function postingStatements(db: D1Database, p: Posting, now: string): D1PreparedStatement[] {
  const entries = p.entries.filter(e => e.amount !== 0);
  assertBalanced(entries);
  const txnId = newId('txn');
  return [
    db.prepare('INSERT INTO ledger_transactions (id, kind, reference_id, memo, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(txnId, p.kind, p.referenceId, p.memo, now),
    ...entries.map(e =>
      db.prepare('INSERT INTO ledger_entries (txn_id, account, currency, amount_minor, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(txnId, e.account, e.currency, e.amount, now)),
  ];
}

/** Signed sum (debit positive) of an account. */
export async function accountSum(db: D1Database, account: string, currency: string): Promise<number> {
  const r = await db.prepare('SELECT COALESCE(SUM(amount_minor), 0) AS s FROM ledger_entries WHERE account = ? AND currency = ?')
    .bind(account, currency).first<{ s: number }>();
  return r?.s ?? 0;
}

/** Wallet projection deltas, applied in the same batch; CHECK (>= 0) on each column blocks overdrafts. */
export interface WalletDelta {
  pending?: number;
  available?: number;
  reservedBid?: number;
  reservedPayout?: number;
  paid?: number;
  clawbackDue?: number;
}

export function walletStatements(db: D1Database, userId: string, currency: string, d: WalletDelta): D1PreparedStatement[] {
  return [
    db.prepare('INSERT INTO wallet_balances (user_id, currency) VALUES (?, ?) ON CONFLICT (user_id, currency) DO NOTHING').bind(userId, currency),
    db.prepare(`UPDATE wallet_balances SET
        pending_minor = pending_minor + ?, available_minor = available_minor + ?,
        reserved_bid_minor = reserved_bid_minor + ?, reserved_payout_minor = reserved_payout_minor + ?,
        paid_minor = paid_minor + ?, clawback_due_minor = clawback_due_minor + ?
      WHERE user_id = ? AND currency = ?`)
      .bind(d.pending ?? 0, d.available ?? 0, d.reservedBid ?? 0, d.reservedPayout ?? 0, d.paid ?? 0, d.clawbackDue ?? 0, userId, currency),
  ];
}

export function outboxStatement(db: D1Database, type: string, aggregateId: string, payload: unknown, now: string) {
  return db.prepare('INSERT INTO outbox_events (id, event_type, aggregate_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(newId('evt'), type, aggregateId, JSON.stringify(payload), now);
}

export function decisionStatement(db: D1Database, d: { actor: string; action: string; decision: 'allow' | 'deny' | 'defer'; reasons: string[]; policy: string; resourceId?: string; result?: unknown }, now: string) {
  return db.prepare('INSERT INTO decision_logs (id, actor, action, decision, reason_codes_json, policy_version, resource_id, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId('dec'), d.actor, d.action, d.decision, JSON.stringify(d.reasons), d.policy, d.resourceId ?? null, d.result === undefined ? null : JSON.stringify(d.result), now);
}
