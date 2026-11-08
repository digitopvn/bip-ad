// User MCP (/mcp). The caller is always the OAuth-authenticated user in the token props;
// tools never accept a user id argument, so one tenant cannot act for another (A18).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyWallet, beginCheckout, intentStatus, quote } from '../domain/bidding';
import { BOARD_HOURS, BOARDS, config, RANKING_POLICY_VERSION } from '../domain/config';
import { DomainError } from '../domain/errors';
import { createProduct, getProduct, listOwnedProducts, ownedProduct, pageBlocks, publishPage, setBlocks, submitProduct, updateProduct } from '../domain/products';
import { loadStandings } from '../domain/ranking';
import { getOrCreateReferralCode, referralStats } from '../domain/referrals';
import { WIDGET_TYPES } from '../domain/widgets';
import { payoutStatus, requestPayout, walletBalances } from '../domain/wallet';
import type { Env } from '../env';
import { nextCutoffAfter, iso } from '../lib/time';
import { jsonTool } from './common';
import { createProviderCheckout } from '../payments/checkout';

const board = z.enum(['daily', 'weekly', 'monthly']);
const idem = z.string().min(8).max(100).describe('Client-generated idempotency key; reuse it when retrying the same request');

export function userMcpServer(env: Env, userId: string) {
  const db = env.DB;
  const cfg = config(env);
  const server = new McpServer({ name: 'bip-ad', version: '0.1.0' }, {
    instructions: 'BIP.AD lists products on three pay-to-win boards (Daily/Weekly/Monthly) that lock at 03:12 ICT. Create a product, set page blocks, submit, then quote and check out boosts. Checkouts are paid by the human on the returned URL. All bids are all-pay: no refunds for being outbid, no guaranteed results.',
  });

  const productView = (p: Awaited<ReturnType<typeof getProduct>>) => p && ({
    product_id: p.id, slug: p.slug, name: p.name, tagline: p.tagline, website_url: p.website_url, image_url: p.image_url,
    status: p.status, version: p.version, page_version_id: p.current_page_version_id, published_at: p.published_at,
    pending_review: { fields: !!p.pending_edit_json, page_version_id: p.pending_page_version_id },
    public_url: `${cfg.origin}/p/${p.slug}`,
  });

  jsonTool(server, 'products.create', 'Create a draft product owned by the signed-in user.', {
    name: z.string().max(80), tagline: z.string().max(160), website_url: z.string().url(), slug: z.string().max(48).optional(), image_url: z.string().url().optional(), idempotency_key: idem,
  }, false, async a => productView(await createProduct(db, userId, a, a.idempotency_key)));

  jsonTool(server, 'products.update', 'Edit a product you own. Pass resource_version (the product version you read) for optimistic concurrency. Edits to a published product go live after moderation (see pending_review).', {
    product_id: z.string(), name: z.string().max(80).optional(), tagline: z.string().max(160).optional(), website_url: z.string().url().optional(), image_url: z.string().url().nullable().optional(), resource_version: z.number().int().optional(),
  }, false, async a => productView(await updateProduct(db, cfg, userId, a.product_id, { name: a.name, tagline: a.tagline, website_url: a.website_url, image_url: a.image_url ?? (a.image_url === null ? '' : undefined) }, a.resource_version)));

  jsonTool(server, 'products.submit', 'Submit a product for moderation and publication. Requires page blocks.', { product_id: z.string() }, false,
    async a => productView(await submitProduct(db, cfg, userId, a.product_id)));

  jsonTool(server, 'products.get', 'Get one of your products.', { product_id: z.string() }, true, async a => productView(await ownedProduct(db, userId, a.product_id)));

  jsonTool(server, 'products.list', 'List your products.', {}, true, async () => (await listOwnedProducts(db, userId)).map(productView));

  jsonTool(server, 'pages.set_blocks', `Save a new page version from widget blocks (schema widgets-v1). Allowed types: ${WIDGET_TYPES.join(', ')}. No HTML or scripts; URLs must be public http(s).`, {
    product_id: z.string(), blocks: z.array(z.record(z.string(), z.unknown())).describe('Ordered widget blocks, e.g. [{"type":"hero","headline":"..."}]'),
  }, false, async a => {
    const r = await setBlocks(db, userId, a.product_id, a.blocks);
    if (!r.ok) return { ok: false, issues: r.issues };
    const p = (await getProduct(db, a.product_id))!;
    return { ok: true, page_version_id: r.pageVersionId, version: r.version, preview_url: `${cfg.origin}/p/${p.slug}?preview=${r.version}` };
  });

  jsonTool(server, 'pages.preview', 'Preview URL and validation issues for the latest (or given) page version.', { product_id: z.string(), version: z.number().int().optional() }, true, async a => {
    const p = await ownedProduct(db, userId, a.product_id);
    const row = await db.prepare(`SELECT version, moderation_status FROM product_page_versions WHERE product_id = ? ${a.version ? 'AND version = ?' : ''} ORDER BY version DESC LIMIT 1`)
      .bind(...(a.version ? [p.id, a.version] : [p.id])).first<{ version: number; moderation_status: string }>();
    if (!row) throw new DomainError('not_found', 'No page versions yet', 404);
    return { version: row.version, moderation_status: row.moderation_status, preview_url: `${cfg.origin}/p/${p.slug}?preview=${row.version}`, issues: [] };
  });

  jsonTool(server, 'pages.publish', 'Publish a page version (latest when version is omitted). On a published product the new version goes live after moderation; pending_review tells you if it is waiting.', { product_id: z.string(), version: z.number().int().optional() }, false, async a => {
    const r = await publishPage(db, cfg, userId, a.product_id, a.version);
    if (!r.ok) return { ok: false, issues: r.issues };
    const p = (await getProduct(db, a.product_id))!;
    return { ok: true, page_version_id: r.pageVersionId, version: r.version, product_status: r.productStatus, pending_review: r.pendingReview, reasons: r.reasons, public_url: `${cfg.origin}/p/${p.slug}` };
  });

  jsonTool(server, 'boards.get', 'Live leaderboard for a board with the next 03:12 ICT cutoff. Ranking: active bid DESC, then owner successful referrals, valid clicks, valid views.', { board, limit: z.number().int().min(1).max(100).optional() }, true, async a => {
    const now = Date.now();
    const rows = await loadStandings(db, a.board, now);
    return {
      board: a.board, ranking_policy_version: RANKING_POLICY_VERSION, active_window_hours: BOARD_HOURS[a.board],
      next_cutoff_at: iso(nextCutoffAfter(now)), seconds_to_cutoff: Math.round((nextCutoffAfter(now) - now) / 1000),
      rows: rows.slice(0, a.limit ?? 25).map(r => ({ rank: r.rank, slug: r.slug, name: r.name, active_rank_units: r.activeRankUnits, owner_successful_referrals: r.ownerSuccessfulReferrals, valid_clicks: r.validClicks, valid_views: r.validViews, free: r.activeRankUnits === 0 })),
    };
  });

  jsonTool(server, 'boosts.quote', 'Quote a bid increment for one of your published products. Locks price and FX for the quote TTL. Does not charge or rank anything. Reusing an idempotency_key with different parameters is a 409.', {
    product_id: z.string(), board, increment_rank_units: z.number().int().describe('USD cents equivalent, e.g. 1000 = $10'), currency: z.enum(['USD', 'VND']).describe('USD pays via PayPal, VND via SePay VietQR'), idempotency_key: idem,
  }, false, async a => {
    const { intent, projectedRank } = await quote(db, cfg, userId, { productId: a.product_id, board: a.board, rankUnits: a.increment_rank_units, currency: a.currency, idempotencyKey: a.idempotency_key });
    return {
      intent_id: intent.id, status: intent.status, board: intent.board, increment_rank_units: intent.rank_units,
      price: { currency: intent.quote_currency, amount_minor: intent.quote_minor, fx_rate: intent.fx_rate, fx_source: intent.fx_source },
      quote_expires_at: intent.quote_expires_at, projected_rank: projectedRank, active_window_hours: BOARD_HOURS[intent.board],
      terms: 'All-pay: you pay whether or not you reach the Top 10. No refunds for being outbid. No guaranteed impressions, clicks or results. Pay-to-win ranking.',
    };
  });

  jsonTool(server, 'boosts.checkout', 'Create a checkout for a quote. Returns a URL the human must open to approve and pay. To use commission-wallet funds, pass wallet_amount_minor here or call wallet.apply_to_bid before the first checkout; the split is fixed once checkout starts. Rank changes only after the payment is verified.', {
    intent_id: z.string(), provider: z.enum(['paypal', 'sepay', 'wallet']), wallet_amount_minor: z.number().int().min(0).optional(),
  }, false, async a => {
    const r = await beginCheckout(db, cfg, userId, a.intent_id, a.provider, { walletMinor: a.wallet_amount_minor });
    const provider = a.provider !== 'wallet' && r.dueMinor > 0 ? await createProviderCheckout(env, cfg, r.intent, a.provider) : null;
    return { intent_id: r.intent.id, status: r.intent.status, checkout_url: r.checkoutUrl, due_minor: r.dueMinor, currency: r.intent.quote_currency, wallet_applied_minor: r.intent.wallet_applied_minor, payment_mode: cfg.paymentMode, provider_redirect: provider?.redirectUrl ?? null };
  });

  jsonTool(server, 'boosts.status', 'Payment, contribution, current rank and expiry for a bid intent.', { intent_id: z.string() }, true, async a => intentStatus(db, userId, a.intent_id));

  jsonTool(server, 'referrals.get_link', 'Your referral link and code (created on first call).', {}, true, async () => {
    const code = await getOrCreateReferralCode(db, userId);
    return { code, link: `${cfg.origin}/r/${code}`, policy: '5% of the first external-cash bid of each referred account, available after the hold period.' };
  });

  jsonTool(server, 'referrals.stats', 'Your successful/pending referrals and commission totals.', {}, true, async () => referralStats(db, userId));

  jsonTool(server, 'wallet.balance', 'Commission wallet balances (pending, available, reserved, paid) per currency.', {}, true, async () => ({ balances: await walletBalances(db, userId) }));

  jsonTool(server, 'wallet.apply_to_bid', 'Reserve available commission balance for a fresh quote (before boosts.checkout). Consumed only when the bid settles; released if the quote expires or the payment needs review.', {
    intent_id: z.string(), amount_minor: z.number().int().positive(),
  }, false, async a => {
    const i = await applyWallet(db, userId, a.intent_id, a.amount_minor);
    return { intent_id: i.id, wallet_applied_minor: i.wallet_applied_minor, due_minor: i.quote_minor - i.wallet_applied_minor, currency: i.quote_currency };
  });

  jsonTool(server, 'payouts.request', 'Request a payout of available commission earned from real payments. Funds are reserved now and transferred manually on days 01-10 of the month. Disabled while payments are simulated.', {
    currency: z.enum(['USD', 'VND']), amount_minor: z.number().int().positive(), payout_method: z.enum(['bank_transfer', 'paypal']), beneficiary_reference: z.string().min(4).max(200).describe('Where to send the money (stored encrypted)'), idempotency_key: idem,
  }, false, async a => requestPayout(db, cfg, env.SESSION_SECRET, userId, { currency: a.currency, amountMinor: a.amount_minor, payoutMethod: a.payout_method, beneficiaryReference: a.beneficiary_reference, idempotencyKey: a.idempotency_key }));

  jsonTool(server, 'payouts.status', 'Your payout requests and reconciled transfers.', {}, true, async () => ({ payouts: await payoutStatus(db, userId) }));

  jsonTool(server, 'analytics.product', 'Valid unique views/clicks (rolling 30 days) and standings for one of your products.', { product_id: z.string() }, true, async a => {
    const p = await ownedProduct(db, userId, a.product_id);
    const now = Date.now();
    const standings = [];
    for (const b of BOARDS) {
      const r = (await loadStandings(db, b, now)).find(x => x.productId === p.id);
      standings.push({ board: b, rank: r?.rank ?? null, active_rank_units: r?.activeRankUnits ?? 0, valid_clicks: r?.validClicks ?? 0, valid_views: r?.validViews ?? 0 });
    }
    const { results } = await db.prepare(`SELECT event_type, COUNT(*) AS n FROM measurement_events WHERE product_id = ? AND occurred_at > ? GROUP BY event_type`).bind(p.id, iso(now - 30 * 86400_000)).all();
    const page = await pageBlocks(db, p.current_page_version_id);
    return { product_id: p.id, window: 'rolling_30d', deduped_daily_events: results, standings, page_version: page?.version ?? null };
  });

  return server;
}
