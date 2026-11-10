// Operator MCP (/operator/mcp): separate identity (OPERATOR_TOKEN bearer), never a user token.
// Tools cannot edit balances directly; every money movement goes through audited domain functions.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BOARDS, config, isBoard } from '../domain/config';
import { RESOLVABLE_REVIEW, resolvePaymentReview, STALE_CLAIM_MS } from '../domain/bidding';
import { DomainError } from '../domain/errors';
import { decisionStatement } from '../domain/ledger';
import { moderateProduct, pendingModeration } from '../domain/products';
import { CATCH_UP_DAYS, finalizeCohort, freezeBoard, produceMockMedia, runLock } from '../domain/snapshot';
import { failPayout, piiKeys, preparePayoutBatch, recordManualTransfer } from '../domain/wallet';
import type { Env } from '../env';
import { iso } from '../lib/time';
import { jsonTool } from './common';
import { emailProjectionBacklog } from '../email/email-projection-state';
import { runModerationJob, scoresForMany } from '../moderation/ai-moderation-pipeline';
import { type AdapterRequestRow, describeRequest, listDeadLetters, openDeadLetterCount } from '../ads/adapter-call-log';
import { retryDeadLetter } from '../ads/adapter-dead-letter-retry';
import { ADS_EXECUTE_POLICY, adsBlockers, adsReport, executeFlights, planDueFlights } from '../ads/ads-flight-operations';
import { pauseFlights, readKillSwitch, reconcileHealthy, resumeFlights, setKillSwitch } from '../ads/ads-safety-controls';
import { parseAdsChannels } from '../ads/zernio-ads-adapter';
import { detectAlerts } from '../monitoring/operator-alerts';
import { publishSnapshot } from '../social/social-publisher';
import { zernioAccounts } from '../social/zernio-social-adapter';

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

  jsonTool(server, 'operator.health', 'Email projection backlog, last lock, pending moderation and payout counts, adapter modes, ads kill switch, dead letters and current alert conditions.', {}, true, async () => {
    const q = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
    const rec = await reconcile(db);
    const ads = parseAdsChannels(env.ZERNIO_ADS_ACCOUNTS);
    return {
      payment_mode: cfg.paymentMode,
      pending_moderation: await q(`SELECT COUNT(*) AS n FROM products WHERE status = 'pending_review'`),
      // Domain events the email projector has not handled yet (it is their only consumer).
      email_projection_backlog: await emailProjectionBacklog(db),
      open_payout_requests: await q(`SELECT COUNT(*) AS n FROM payout_requests WHERE state IN ('requested', 'batched')`),
      last_lock: await db.prepare(`SELECT resource_id, status, finished_at FROM job_runs WHERE job_type = 'daily_lock' ORDER BY resource_id DESC LIMIT 1`).first(),
      adapters: {
        video: 'mocked',
        social: { mode: cfg.socialMode, zernio_key_set: !!env.ZERNIO_API_KEY, accounts: Object.keys(zernioAccounts(env)) },
        ads: { mode: cfg.adsMode, zernio_key_set: !!env.ZERNIO_API_KEY, channels: ads.channels.map(c => c.channel), channel_config_error: ads.error },
      },
      ads_kill_switch: await readKillSwitch(db, cfg),
      reconcile_balanced: reconcileHealthy(rec),
      dead_letters_open: await openDeadLetterCount(db),
      alerts: (await detectAlerts(db, rec)).map(x => ({ kind: x.kind, title: x.title, ...x.detail })),
      operator_alerts_unsent: await q(`SELECT COUNT(*) AS n FROM operator_alerts WHERE status IN ('pending', 'failed')`),
      alert_email_set: !!env.OPERATOR_ALERT_EMAIL,
    };
  });

  jsonTool(server, 'products.pending', 'Products waiting for moderation: submissions, and pending field edits or page versions of published products (with their version), each with the AI moderation scores of that exact version (ai_moderation).', {}, true,
    async () => {
      const rows = await pendingModeration(db);
      const scores = await scoresForMany(db, rows.map(r => ({ productId: String(r.id), version: Number(r.version) })));
      const products = rows.map(r => ({ ...r, ai_moderation: scores.get(`${r.id}@${r.version}`) }));
      return { moderation_mode: cfg.moderationMode, products };
    });

  jsonTool(server, 'moderation.rescore', 'Run AI moderation again for the current version of a product awaiting moderation (both stages, inline). In ai mode a passing verdict publishes it.', { product_id: z.string() }, false,
    async a => runModerationJob(env, cfg, a.product_id, undefined, true));

  jsonTool(server, 'products.moderate', 'Approve, reject or suspend a product, with a reason code (logged). Every approval needs the product_version you reviewed (from products.pending).', {
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

  jsonTool(server, 'locks.run', 'Run the full 03:12 lock (3 snapshots, 3 cohorts with their ad flights, mock media) for a cutoff. Idempotent.', { cutoff_at: z.string() }, false, async a => runLock(db, cfg.origin, cutoffArg(a.cutoff_at)));

  jsonTool(server, 'videos.render', 'Mock video adapter: records the Top 10 composition and content hash with status "mocked". No MP4 is rendered.', { snapshot_id: z.string() }, false, async a => {
    await produceMockMedia(db, a.snapshot_id, cfg.origin);
    const { results } = await db.prepare('SELECT type, url, content_hash, status FROM content_assets WHERE snapshot_id = ?').bind(a.snapshot_id).all();
    return { assets: results };
  });

  jsonTool(server, 'social.publish', 'Publish a snapshot\'s Top 10 to X, Facebook, YouTube and TikTok through Zernio. SOCIAL_MODE=mock (default): nothing is posted and the mocked records are shown. live: one idempotent post per platform; YouTube and TikTok need video_url (a public https video you checked); failures go to the dead-letter queue.', {
    snapshot_id: z.string(), video_url: z.url({ protocol: /^https$/ }).max(2000).optional(),
  }, false, async a => publishSnapshot(env, cfg, a.snapshot_id, { actor: ACTOR, videoUrl: a.video_url }));

  jsonTool(server, 'ads.plan', 'Plan the ad flights the lock created: split each flight\'s budget across the configured channels within its spend cap and daily cap (deterministic rules, one board per flight). Then lists flights with their allocations.', {
    board: z.enum(['daily', 'weekly', 'monthly']).optional(),
  }, false, async a => {
    const blockers = await adsBlockers(env, cfg, reconcile);
    const run = blockers.length ? { planned: [], channel_config_error: null, blocked: blockers } : await planDueFlights(env, cfg, { actor: ACTOR });
    const { results } = await db.prepare(`SELECT f.*, c.cutoff_at, (SELECT json_group_array(json_object('channel', channel, 'daily_minor', daily_minor, 'amount_minor', amount_minor, 'state', state))
        FROM ad_flight_allocations WHERE flight_id = f.id) AS allocations FROM ad_flights f JOIN revenue_cohorts c ON c.id = f.cohort_id ${a.board ? 'WHERE f.board = ?' : ''} ORDER BY f.start_at DESC LIMIT 100`)
      .bind(...(a.board ? [a.board] : [])).all<Record<string, unknown>>();
    return { ads_mode: cfg.adsMode, run, flights: results.map(f => ({ ...f, allocations: JSON.parse(String(f.allocations ?? '[]')) })) };
  });

  jsonTool(server, 'ads.execute', 'Execute the planned allocations of a flight whose window is open. Cross-board requests are refused. Dry run (default): the exact Zernio requests are recorded and nothing is sent, committed or spent. Refused while the kill switch is on or finance.reconcile is unbalanced.', {
    flight_id: z.string(), board: z.string(),
  }, false, async a => {
    const f = await db.prepare('SELECT id, board FROM ad_flights WHERE id = ?').bind(a.flight_id).first<{ id: string; board: string }>();
    if (!f) throw new DomainError('not_found', 'Flight not found', 404);
    if (!isBoard(a.board) || a.board !== f.board) {
      await decisionStatement(db, { actor: ACTOR, action: 'ads.execute', decision: 'deny', reasons: ['CROSS_BOARD_SPEND'], policy: ADS_EXECUTE_POLICY, resourceId: f.id, result: { board: a.board } }, iso(Date.now())).run();
      throw new DomainError('cross_board_spend', 'Denied: CROSS_BOARD_SPEND', 403);
    }
    return executeFlights(env, cfg, reconcile, { actor: ACTOR, flightId: f.id });
  });

  jsonTool(server, 'ads.pause', 'Pause one flight, or every unfinished flight when flight_id is omitted. Logged; live campaigns are paused at the provider too.', {
    flight_id: z.string().optional(), reason: z.string().min(3).max(200),
  }, false, async a => pauseFlights(env, cfg, `OPERATOR: ${a.reason}`, { actor: ACTOR, flightIds: a.flight_id ? [a.flight_id] : undefined }));

  jsonTool(server, 'ads.resume', 'Resume paused flights where they stopped (one, or all). Refused while the kill switch is on or finance.reconcile is unbalanced.', {
    flight_id: z.string().optional(), note: z.string().min(3).max(200),
  }, false, async a => resumeFlights(env, cfg, reconcile, a.note, { actor: ACTOR, flightIds: a.flight_id ? [a.flight_id] : undefined }));

  jsonTool(server, 'ads.kill_switch', 'Engage (pauses every flight and stops planning and execution) or release the ads kill switch. ADS_KILL_SWITCH=true in the configuration overrides a release. Releasing does not resume flights: use ads.resume.', {
    engaged: z.boolean(), reason: z.string().min(3).max(200),
  }, false, async a => setKillSwitch(env, cfg, a.engaged, a.reason, { actor: ACTOR }));

  jsonTool(server, 'ads.report', 'End-of-period report: per ended flight the cap, planned, committed, spent and unspent money with the reasons, plus totals per board.', {
    board: z.enum(['daily', 'weekly', 'monthly']).optional(), ended_before: z.iso.datetime().optional(),
  }, true, async a => adsReport(db, { board: a.board, endedBefore: a.ended_before }));

  jsonTool(server, 'adapters.requests', 'Recorded adapter requests (newest first): in a dry run these are exactly the requests that would be sent. No credentials are stored.', {
    adapter: z.enum(['ads', 'social']).optional(), resource_id: z.string().optional(), limit: z.number().int().min(1).max(200).optional(),
  }, true, async a => {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (a.adapter) { where.push('adapter = ?'); binds.push(a.adapter); }
    if (a.resource_id) { where.push('resource_id = ?'); binds.push(a.resource_id); }
    const { results } = await db.prepare(`SELECT * FROM adapter_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).bind(...binds, a.limit ?? 50).all<AdapterRequestRow>();
    return { requests: results.map(describeRequest) };
  });

  jsonTool(server, 'adapters.dead_letters', 'Failed live adapter calls (Zernio social posts, ad campaigns) waiting for a retry.', { status: z.enum(['open', 'resolved']).optional() }, true,
    async a => ({ dead_letters: await listDeadLetters(db, a.status ?? 'open') }));

  jsonTool(server, 'adapters.retry', 'Retry a dead-lettered adapter call with its original request and idempotency key (no duplicate post or campaign). Refused when the adapter is no longer live.', { dead_letter_id: z.string() }, false,
    async a => retryDeadLetter(env, cfg, a.dead_letter_id, { actor: ACTOR }));

  jsonTool(server, 'payouts.prepare_batch', 'Prepare the monthly manual payout batch (lists beneficiaries for the operator). Idempotent per month.', { window_month: z.string().describe('YYYY-MM') }, false,
    async a => preparePayoutBatch(db, piiKeys(env), ACTOR, a.window_month));

  jsonTool(server, 'payouts.record_manual_transfer', 'Record a bank transfer the operator made by hand (days 01-10 ICT only). Requires reference, exact amount and proof.', {
    payout_request_id: z.string(), bank_transfer_reference: z.string().min(3).max(120), amount_minor: z.number().int().positive(), transferred_at: z.string(), proof_ref: z.string().min(3).max(300),
  }, false, async a => recordManualTransfer(db, ACTOR, { payoutRequestId: a.payout_request_id, bankTransferReference: a.bank_transfer_reference, amountMinor: a.amount_minor, transferredAt: a.transferred_at, proofRef: a.proof_ref }));

  jsonTool(server, 'payouts.fail', 'Mark a payout as failed and return funds to the available balance.', { payout_request_id: z.string(), reason: z.string().max(200) }, false,
    async a => failPayout(db, ACTOR, a.payout_request_id, a.reason));

  jsonTool(server, 'payments.reviews', 'Payment reviews (default: still resolvable): captures that did not match their intent, captures for closed intents, partial refunds, and settlement claims that died before the payment was recorded.', { status: z.enum(['open', 'settled', 'dismissed']).optional() }, true, async a => {
    const { results } = a.status
      ? await db.prepare('SELECT * FROM payment_reviews WHERE status = ? ORDER BY created_at LIMIT 200').bind(a.status).all()
      : await db.prepare(`SELECT * FROM payment_reviews WHERE ${RESOLVABLE_REVIEW} ORDER BY created_at LIMIT 200`).bind(iso(Date.now() - STALE_CLAIM_MS)).all();
    return { reviews: results };
  });

  jsonTool(server, 'payments.resolve_review', 'Resolve a payment review: settle (a capture of exactly the full quote that the provider has not partly refunded) or dismiss (money handled at the provider, e.g. refunded). Settling a partly refunded capture is refused (not_settleable, partially_refunded) and dismisses the review. status "settling" means another request is settling it. Logged.', {
    review_id: z.string(), resolution: z.enum(['settle', 'dismiss']), note: z.string().min(3).max(300),
  }, false, async a => resolvePaymentReview(db, cfg, ACTOR, a.review_id, a.resolution, a.note));

  jsonTool(server, 'finance.reconcile', 'Read-only ledger reconciliation: every transaction balances per currency; wallet projection equals ledger.', {}, true, async () => reconcile(db));

  jsonTool(server, 'operator.decisions', 'Recent decision log entries.', { limit: z.number().int().min(1).max(200).optional() }, true, async a => {
    const { results } = await db.prepare('SELECT * FROM decision_logs ORDER BY created_at DESC LIMIT ?').bind(a.limit ?? 50).all();
    return { decisions: results };
  });

  jsonTool(server, 'emails.list', 'Recent transactional emails (newest first), optionally filtered by status, user or kind. No message bodies.', {
    status: z.enum(['pending', 'sending', 'sent', 'skipped', 'failed']).optional(), user_id: z.string().max(64).optional(), kind: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }, true, async a => {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (a.status) { where.push('status = ?'); binds.push(a.status); }
    if (a.user_id) { where.push('user_id = ?'); binds.push(a.user_id); }
    if (a.kind) { where.push('kind = ?'); binds.push(a.kind); }
    const { results } = await db.prepare(`SELECT id, user_id, kind, to_address, status, skip_reason, attempts, last_error, provider_message_id, created_at, sent_at
        FROM email_outbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...binds, a.limit ?? 50).all();
    return { emails: results };
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
