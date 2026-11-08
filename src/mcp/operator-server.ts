// Operator MCP (/operator/mcp): separate identity (OPERATOR_TOKEN bearer), never a user token.
// Tools cannot edit balances directly; every money movement goes through audited domain functions.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BOARDS, config, isBoard } from '../domain/config';
import { resolvePaymentReview } from '../domain/bidding';
import { DomainError } from '../domain/errors';
import { decisionStatement } from '../domain/ledger';
import { moderateProduct, pendingModeration } from '../domain/products';
import { CATCH_UP_DAYS, finalizeCohort, freezeBoard, produceMockMedia, runLock } from '../domain/snapshot';
import { failPayout, preparePayoutBatch, recordManualTransfer } from '../domain/wallet';
import type { Env } from '../env';
import { iso } from '../lib/time';
import { jsonTool } from './common';

const ACTOR = 'operator:grok';

function cutoffArg(s: string) {
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new DomainError('invalid_cutoff', 'cutoff_at must be an ISO timestamp');
  const d = new Date(ms);
  // 03:12 ICT == 20:12 UTC.
  if (d.getUTCHours() !== 20 || d.getUTCMinutes() !== 12 || d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) throw new DomainError('invalid_cutoff', 'cutoff_at must be exactly 03:12:00 ICT (20:12:00Z)');
  if (ms > Date.now()) throw new DomainError('invalid_cutoff', 'cutoff_at is in the future');
  // A snapshot is "immutable" only if taken near its cutoff: older ones would freeze today's data.
  if (Date.now() - ms > CATCH_UP_DAYS * 86400_000) throw new DomainError('invalid_cutoff', `cutoff_at is more than ${CATCH_UP_DAYS} days old; backfills are not supported`);
  return ms;
}


export function operatorMcpServer(env: Env) {
  const db = env.DB;
  const cfg = config(env);
  const server = new McpServer({ name: 'bip-ad-operator', version: '0.1.0' });

  jsonTool(server, 'operator.health', 'Queue depth, last lock, pending moderation and payout counts.', {}, true, async () => {
    const q = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
    return {
      payment_mode: cfg.paymentMode,
      pending_moderation: await q(`SELECT COUNT(*) AS n FROM products WHERE status = 'pending_review'`),
      pending_outbox: await q(`SELECT COUNT(*) AS n FROM outbox_events WHERE status = 'pending'`),
      open_payout_requests: await q(`SELECT COUNT(*) AS n FROM payout_requests WHERE state IN ('requested', 'batched')`),
      last_lock: await db.prepare(`SELECT resource_id, status, finished_at FROM job_runs WHERE job_type = 'daily_lock' ORDER BY resource_id DESC LIMIT 1`).first(),
      adapters: { video: 'mocked', social: 'mocked', ads: 'mocked' },
    };
  });

  jsonTool(server, 'products.pending', 'Products waiting for moderation: submissions, and pending field edits or page versions of published products (with their version).', {}, true,
    async () => ({ products: await pendingModeration(db) }));

  jsonTool(server, 'products.moderate', 'Approve, reject or suspend a product, with a reason code (logged). Approving pending changes needs the product_version you reviewed (from products.pending).', {
    product_id: z.string(), decision: z.enum(['approve', 'reject', 'suspend']), reason: z.string().max(200), product_version: z.number().int().optional(),
  }, false, async a => {
    const p = await moderateProduct(db, ACTOR, a.product_id, a.decision, a.reason, Date.now(), a.product_version);
    return { product_id: p.id, status: p.status };
  });

  jsonTool(server, 'boards.freeze', 'Freeze one board at an explicit 03:12 ICT cutoff. Idempotent.', { board: z.enum(['daily', 'weekly', 'monthly']), cutoff_at: z.string() }, false, async a => {
    return freezeBoard(db, a.board, cutoffArg(a.cutoff_at));
  });

  jsonTool(server, 'cohorts.finalize', 'Finalize the revenue cohort of (board, cutoff). Idempotent.', { board: z.enum(['daily', 'weekly', 'monthly']), cutoff_at: z.string() }, false, async a => {
    return finalizeCohort(db, a.board, cutoffArg(a.cutoff_at));
  });

  jsonTool(server, 'locks.run', 'Run the full 03:12 lock (3 snapshots, 3 cohorts, mock media) for a cutoff. Idempotent.', { cutoff_at: z.string() }, false, async a => runLock(db, cfg.origin, cutoffArg(a.cutoff_at)));

  jsonTool(server, 'videos.render', 'Mock video adapter: records the Top 10 composition and content hash with status "mocked". No MP4 is rendered.', { snapshot_id: z.string() }, false, async a => {
    await produceMockMedia(db, a.snapshot_id, cfg.origin);
    const { results } = await db.prepare('SELECT type, url, content_hash, status FROM content_assets WHERE snapshot_id = ?').bind(a.snapshot_id).all();
    return { assets: results };
  });

  jsonTool(server, 'social.publish', 'Mock social adapter (Zernio not connected): shows publication records with status "mocked". Nothing is posted.', { snapshot_id: z.string() }, true, async a => {
    const { results } = await db.prepare('SELECT platform, external_post_id, url, state FROM social_publications WHERE snapshot_id = ?').bind(a.snapshot_id).all();
    return { publications: results };
  });

  jsonTool(server, 'ads.plan', 'Planned ad flights per board with hard spend caps. Ads adapter is mocked; no campaign is created.', { board: z.enum(['daily', 'weekly', 'monthly']).optional() }, true, async a => {
    const { results } = await db.prepare(`SELECT f.*, c.cutoff_at FROM ad_flights f JOIN revenue_cohorts c ON c.id = f.cohort_id ${a.board ? 'WHERE f.board = ?' : ''} ORDER BY f.start_at DESC LIMIT 100`)
      .bind(...(a.board ? [a.board] : [])).all();
    return { flights: results };
  });

  jsonTool(server, 'ads.execute', 'Request spend on a flight. Always checked server-side against the flight cap; cross-board spend is refused. Adapter is mocked.', {
    flight_id: z.string(), board: z.string(), amount_minor: z.number().int().positive(),
  }, false, async a => {
    const f = await db.prepare('SELECT * FROM ad_flights WHERE id = ?').bind(a.flight_id).first<{ id: string; board: string; spend_cap_minor: number; committed_minor: number }>();
    const now = iso(Date.now());
    const deny = async (reason: string) => {
      await decisionStatement(db, { actor: ACTOR, action: 'ads.execute', decision: 'deny', reasons: [reason], policy: 'ads-v1', resourceId: a.flight_id, result: { amount: a.amount_minor } }, now).run();
      throw new DomainError(reason.toLowerCase(), `Denied: ${reason}`, 403);
    };
    if (!f) throw new DomainError('not_found', 'Flight not found', 404);
    if (!isBoard(a.board) || a.board !== f.board) await deny('CROSS_BOARD_SPEND');
    // Cumulative cap, enforced atomically: the commitment is recorded only while it stays within the cap.
    const r = await db.prepare('UPDATE ad_flights SET committed_minor = committed_minor + ? WHERE id = ? AND committed_minor + ? <= spend_cap_minor')
      .bind(a.amount_minor, f.id, a.amount_minor).run();
    if (!r.meta.changes) await deny('EXCEEDS_FLIGHT_CAP');
    await decisionStatement(db, { actor: ACTOR, action: 'ads.execute', decision: 'defer', reasons: ['ADS_ADAPTER_MOCKED'], policy: 'ads-v1', resourceId: f.id, result: { amount: a.amount_minor } }, now).run();
    return { status: 'mocked', committed_minor: f.committed_minor + a.amount_minor, spend_cap_minor: f.spend_cap_minor, note: 'Within cap and committed against it. Ads execution is out of scope for this MVP; nothing was spent.' };
  });

  jsonTool(server, 'payouts.prepare_batch', 'Prepare the monthly manual payout batch (lists beneficiaries for the operator). Idempotent per month.', { window_month: z.string().describe('YYYY-MM') }, false,
    async a => preparePayoutBatch(db, env.SESSION_SECRET, ACTOR, a.window_month));

  jsonTool(server, 'payouts.record_manual_transfer', 'Record a bank transfer the operator made by hand (days 01-10 ICT only). Requires reference, exact amount and proof.', {
    payout_request_id: z.string(), bank_transfer_reference: z.string().min(3).max(120), amount_minor: z.number().int().positive(), transferred_at: z.string(), proof_ref: z.string().min(3).max(300),
  }, false, async a => recordManualTransfer(db, ACTOR, { payoutRequestId: a.payout_request_id, bankTransferReference: a.bank_transfer_reference, amountMinor: a.amount_minor, transferredAt: a.transferred_at, proofRef: a.proof_ref }));

  jsonTool(server, 'payouts.fail', 'Mark a payout as failed and return funds to the available balance.', { payout_request_id: z.string(), reason: z.string().max(200) }, false,
    async a => failPayout(db, ACTOR, a.payout_request_id, a.reason));

  jsonTool(server, 'payments.reviews', 'Open payment reviews: captures that did not match their intent, captures for closed intents, partial refunds.', { status: z.enum(['open', 'settled', 'dismissed']).optional() }, true, async a => {
    const { results } = await db.prepare('SELECT * FROM payment_reviews WHERE status = ? ORDER BY created_at LIMIT 200').bind(a.status ?? 'open').all();
    return { reviews: results };
  });

  jsonTool(server, 'payments.resolve_review', 'Resolve a payment review: settle (a capture of exactly the full quote) or dismiss (money handled at the provider, e.g. refunded). Logged.', {
    review_id: z.string(), resolution: z.enum(['settle', 'dismiss']), note: z.string().min(3).max(300),
  }, false, async a => resolvePaymentReview(db, cfg, ACTOR, a.review_id, a.resolution, a.note));

  jsonTool(server, 'finance.reconcile', 'Read-only ledger reconciliation: every transaction balances per currency; wallet projection equals ledger.', {}, true, async () => reconcile(db));

  jsonTool(server, 'operator.decisions', 'Recent decision log entries.', { limit: z.number().int().min(1).max(200).optional() }, true, async a => {
    const { results } = await db.prepare('SELECT * FROM decision_logs ORDER BY created_at DESC LIMIT ?').bind(a.limit ?? 50).all();
    return { decisions: results };
  });

  return server;
}

export async function reconcile(db: D1Database) {
  const unbalanced = await db.prepare(`SELECT txn_id, currency, SUM(amount_minor) AS s FROM ledger_entries GROUP BY txn_id, currency HAVING s <> 0 LIMIT 20`).all();
  // Wallet projection vs ledger in one pass: ledger sums per wallet account, joined to the projection.
  const { results: drift } = await db.prepare(`WITH l AS (
      SELECT account, currency, -SUM(amount_minor) AS s FROM ledger_entries WHERE account LIKE 'liability:wallet:%' GROUP BY account, currency
    ), w AS (
      SELECT user_id, currency, 'pending' AS k, pending_minor AS v FROM wallet_balances
      UNION ALL SELECT user_id, currency, 'available', available_minor FROM wallet_balances
      UNION ALL SELECT user_id, currency, 'reserved_bid', reserved_bid_minor FROM wallet_balances
      UNION ALL SELECT user_id, currency, 'reserved_payout', reserved_payout_minor FROM wallet_balances
    )
    SELECT w.user_id, w.currency, w.k AS column, w.v AS projection, COALESCE(l.s, 0) AS ledger
    FROM w LEFT JOIN l ON l.account = 'liability:wallet:' || w.user_id || ':' || w.k AND l.currency = w.currency
    WHERE w.v <> COALESCE(l.s, 0) LIMIT 50`).all();
  const { results: funds } = await db.prepare(`SELECT account, currency, -SUM(amount_minor) AS balance FROM ledger_entries
      WHERE account LIKE 'liability:ads_fund:%' OR account LIKE 'asset:cash:%' GROUP BY account, currency ORDER BY account`).all();
  return { balanced: unbalanced.results.length === 0, unbalanced: unbalanced.results, wallet_drift: drift, accounts: funds, boards: BOARDS };
}
