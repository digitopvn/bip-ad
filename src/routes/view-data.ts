// Builds view models (src/views/types.ts) from D1. Views never query the database.
import type { UserRow } from '../auth/session';
import { type IntentRow, PROVIDER_CURRENCY, projectedRank } from '../domain/bidding';
import { type Board, BOARD_HOURS, BOARDS, config, RANKING_POLICY_VERSION } from '../domain/config';
import { getProduct, listOwnedProducts, pageBlocks, type ProductRow } from '../domain/products';
import { loadStandings } from '../domain/ranking';
import { getOrCreateReferralCode, referralStats } from '../domain/referrals';
import { getSnapshot } from '../domain/snapshot';
import { payoutStatus, walletBalances } from '../domain/wallet';
import type { Env } from '../env';
import { cutoffForIctDate, DAY_MS, ictDate, iso, nextCutoffAfter } from '../lib/time';
import type { AccountView, BoardView, CheckoutView, HomeView, LayoutContext, ProductPageView, SnapshotView, WidgetBlock } from '../views/types';

export function layoutCtx(env: Env, path: string, user: UserRow | null, title: string, description?: string): LayoutContext {
  const cfg = config(env);
  return {
    title, description, path, origin: cfg.origin, testMode: cfg.paymentMode !== 'live',
    viewer: user ? { userId: user.id, displayName: user.display_name, avatarUrl: user.avatar_url } : null,
  };
}

export async function buildBoard(env: Env, board: Board, nowMs = Date.now()): Promise<BoardView> {
  const rows = await loadStandings(env.DB, board, nowMs);
  return {
    board,
    nextCutoffAt: iso(nextCutoffAfter(nowMs)),
    rankingPolicyVersion: RANKING_POLICY_VERSION,
    rows: rows.map(r => ({
      rank: r.rank, productId: r.productId, slug: r.slug, name: r.name, tagline: r.tagline, activeRankUnits: r.activeRankUnits,
      ownerSuccessfulReferrals: r.ownerSuccessfulReferrals, validClicks: r.validClicks, validViews: r.validViews, isSample: r.isSample, imageUrl: r.imageUrl,
    })),
  };
}

async function lastSnapshotDate(env: Env, board: Board) {
  const r = await env.DB.prepare('SELECT cutoff_at FROM board_snapshots WHERE board = ? ORDER BY cutoff_at DESC LIMIT 1').bind(board).first<{ cutoff_at: string }>();
  return r ? ictDate(Date.parse(r.cutoff_at)) : undefined;
}

export async function homeView(env: Env): Promise<HomeView> {
  const now = Date.now();
  const boards = {} as HomeView['boards'];
  const last: HomeView['lastSnapshotDate'] = {};
  for (const b of BOARDS) {
    boards[b] = await buildBoard(env, b, now);
    const d = await lastSnapshotDate(env, b);
    if (d) last[b] = d;
  }
  return { boards, active: 'daily', lastSnapshotDate: last, mcpUrl: `${config(env).origin}/mcp` };
}

export async function boardView(env: Env, board: Board) {
  return { view: await buildBoard(env, board), lastSnapshotDate: await lastSnapshotDate(env, board) };
}

export async function productView(env: Env, p: ProductRow, previewVersion: number | null): Promise<ProductPageView> {
  let page: { id: string; version: number; blocks_json: string } | null = null;
  if (previewVersion) {
    page = await env.DB.prepare('SELECT id, version, blocks_json FROM product_page_versions WHERE product_id = ? AND version = ?').bind(p.id, previewVersion).first();
  } else {
    page = await pageBlocks(env.DB, p.current_page_version_id);
  }
  const now = Date.now();
  const standings = [];
  let refs = 0;
  for (const b of BOARDS) {
    const r = (await loadStandings(env.DB, b, now)).find(x => x.productId === p.id);
    if (r) refs = r.ownerSuccessfulReferrals;
    standings.push({ board: b, rank: r?.rank ?? null, activeRankUnits: r?.activeRankUnits ?? 0 });
  }
  return {
    productId: p.id, slug: p.slug, name: p.name, tagline: p.tagline, websiteUrl: p.website_url, outboundPath: `/go/${p.slug}`,
    isSample: p.is_sample === 1, status: p.status, previewVersion: previewVersion ? page?.version ?? null : null, pageVersion: page?.version ?? null,
    blocks: page ? (JSON.parse(page.blocks_json) as WidgetBlock[]) : [], standings, ownerSuccessfulReferrals: refs,
  };
}

export async function snapshotView(env: Env, board: Board, date: string): Promise<SnapshotView | null> {
  const cutoff = cutoffForIctDate(date);
  const snap = await getSnapshot(env.DB, board, cutoff);
  if (!snap) return null;
  const { results: items } = await env.DB.prepare(`SELECT i.*, p.slug, p.name, p.is_sample FROM board_snapshot_items i JOIN products p ON p.id = i.product_id
      WHERE i.snapshot_id = ? ORDER BY i.rank`).bind(snap.id).all<Record<string, unknown>>();
  const { results: assets } = await env.DB.prepare('SELECT type, url, status FROM content_assets WHERE snapshot_id = ?').bind(snap.id).all<{ type: string; url: string | null; status: string }>();
  const { results: pubs } = await env.DB.prepare('SELECT platform, url, state FROM social_publications WHERE snapshot_id = ? ORDER BY platform').bind(snap.id).all<{ platform: string; url: string | null; state: string }>();
  const { results: cohorts } = await env.DB.prepare('SELECT * FROM revenue_cohorts WHERE board = ? AND cutoff_at = ? ORDER BY currency').bind(board, snap.cutoff_at).all<Record<string, number | string>>();
  const near = async (dir: 1 | -1) => {
    const r = await env.DB.prepare(`SELECT cutoff_at FROM board_snapshots WHERE board = ? AND cutoff_at ${dir > 0 ? '>' : '<'} ? ORDER BY cutoff_at ${dir > 0 ? 'ASC' : 'DESC'} LIMIT 1`).bind(board, snap.cutoff_at).first<{ cutoff_at: string }>();
    return r ? ictDate(Date.parse(r.cutoff_at)) : null;
  };
  return {
    board, date, cutoffAt: snap.cutoff_at, executedAt: snap.executed_at, rankingPolicyVersion: snap.ranking_policy_version,
    items: items.map(i => ({
      rank: i.rank as number, slug: i.slug as string, name: i.name as string, rankUnits: i.rank_units as number,
      ownerSuccessfulReferrals: i.owner_successful_referrals as number, validClicks: i.valid_unique_clicks as number, validViews: i.valid_unique_views as number,
      visibilityState: i.visibility_state as 'visible' | 'removed_from_publication', isSample: i.is_sample === 1,
    })),
    media: [...assets.map(a => ({ kind: a.type === 'video_composition' ? 'video' : a.type, platform: null, status: a.status, url: a.url })), ...pubs.map(p => ({ kind: 'social post', platform: p.platform, status: p.state, url: p.url }))],
    cohort: cohorts.map(c => ({ currency: c.currency as string, eligibleRevenueMinor: c.eligible_revenue_minor as number, adsFundMinor: c.ads_fund_minor as number, commissionMinor: c.referral_commission_minor as number, operatorMinor: c.operator_allocation_minor as number })),
    prevDate: await near(-1), nextDate: await near(1),
  };
}

export async function accountView(env: Env, user: UserRow): Promise<AccountView> {
  const db = env.DB;
  const cfg = config(env);
  const now = Date.now();
  const standings = Object.fromEntries(await Promise.all(BOARDS.map(async b => [b, await loadStandings(db, b, now)] as const)));
  const products = (await listOwnedProducts(db, user.id)).map(p => ({
    slug: p.slug, name: p.name, status: p.status,
    standings: BOARDS.map(b => { const r = standings[b].find(x => x.productId === p.id); return { board: b, rank: r?.rank ?? null, activeRankUnits: r?.activeRankUnits ?? 0 }; }),
  }));
  const { results: payments } = await db.prepare(`SELECT p.created_at, i.board, pr.name, p.currency, p.cash_minor + p.wallet_minor AS amount, p.provider, p.state
      FROM payments p JOIN bid_intents i ON i.id = p.bid_intent_id JOIN products pr ON pr.id = i.product_id WHERE i.owner_id = ? ORDER BY p.created_at DESC LIMIT 50`).bind(user.id).all<Record<string, string | number>>();
  const code = await getOrCreateReferralCode(db, user.id);
  const stats = await referralStats(db, user.id);
  const balances = await walletBalances(db, user.id);
  const line = (k: keyof (typeof balances)[number]) => balances.filter(b => (b[k] as number) > 0).map(b => ({ currency: b.currency, minor: b[k] as number }));
  const { results: hist } = await db.prepare(`SELECT e.created_at, e.currency, e.amount_minor, e.account, t.memo FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.txn_id
      WHERE e.account LIKE ? ORDER BY e.id DESC LIMIT 50`).bind(`liability:wallet:${user.id}:%`).all<{ created_at: string; currency: string; amount_minor: number; account: string; memo: string }>();
  const payouts = (await payoutStatus(db, user.id)) as Record<string, string | number | null>[];
  return {
    viewer: { userId: user.id, displayName: user.display_name, avatarUrl: user.avatar_url },
    products,
    payments: payments.map(p => ({ createdAt: p.created_at as string, board: p.board as Board, productName: p.name as string, currency: p.currency as string, amountMinor: p.amount as number, provider: p.provider as string, state: p.state as string })),
    referral: { code, link: `${cfg.origin}/r/${code}`, successful: stats.successful, pending: stats.pending },
    wallet: { pending: line('pending_minor'), available: line('available_minor'), reservedForBid: line('reserved_for_bid_minor'), reservedForPayout: line('reserved_for_payout_minor'), paid: line('paid_minor') },
    // Liabilities are credit-normal: a credit (negative) raises what the user is owed.
    walletHistory: hist.map(h => ({ at: h.created_at, currency: h.currency, deltaMinor: -h.amount_minor, memo: `${h.memo} (${h.account.split(':').pop()})` })),
    payouts: payouts.map(p => ({ requestedAt: p.requested_at as string, currency: p.currency as string, requestedMinor: p.requested_minor as number, state: p.state as string, transferReference: (p.bank_transfer_reference as string) ?? null })),
    mcpUrl: `${cfg.origin}/mcp`,
  };
}

export async function checkoutView(env: Env, intent: IntentRow, isOwner: boolean, csrf: string, message: string | null): Promise<CheckoutView> {
  const cfg = config(env);
  const p = await getProduct(env.DB, intent.product_id);
  const providers = (Object.keys(PROVIDER_CURRENCY) as ('paypal' | 'sepay')[]).filter(k => PROVIDER_CURRENCY[k] === intent.quote_currency);
  const expired = intent.status === 'quoted' || intent.status === 'awaiting_payment' ? Date.parse(intent.quote_expires_at) <= Date.now() : false;
  return {
    intentId: intent.id, status: expired ? 'expired' : intent.status, productName: p?.name ?? 'Unknown product', productSlug: p?.slug ?? '',
    board: intent.board, rankUnits: intent.rank_units, quoteCurrency: intent.quote_currency, quoteMinor: intent.quote_minor,
    walletAppliedMinor: intent.wallet_applied_minor, dueMinor: intent.quote_minor - intent.wallet_applied_minor,
    fxRate: intent.fx_rate ? Number(intent.fx_rate) : null, quoteExpiresAt: intent.quote_expires_at, activeHours: BOARD_HOURS[intent.board],
    projectedRank: await projectedRank(env.DB, intent.board, intent.product_id, intent.status === 'confirmed' ? 0 : intent.rank_units),
    providers, paymentMode: cfg.paymentMode, isOwner, csrf, message,
  };
}

export { DAY_MS };
