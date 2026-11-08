// Ranking policy rank-v1 (brief section 3.1). Pay-to-win is absolute: referrals, clicks and
// views only break ties between equal active bids, including the zero-bid free group.
import { iso } from '../lib/time';
import { type Board, METRIC_WINDOW_MS } from './config';

export interface RankInput {
  productId: string;
  activeRankUnits: number;
  ownerSuccessfulReferrals: number;
  validClicks: number;
  validViews: number;
  /** When the current active amount was reached (latest active contribution start). Null when 0. */
  achievedAt: string | null;
  publishedAt: string;
}

export function compareRank(a: RankInput, b: RankInput): number {
  return (
    b.activeRankUnits - a.activeRankUnits ||
    b.ownerSuccessfulReferrals - a.ownerSuccessfulReferrals ||
    b.validClicks - a.validClicks ||
    b.validViews - a.validViews ||
    // Full tie with a positive bid: whoever reached the amount first stays ahead.
    (a.activeRankUnits > 0 ? (a.achievedAt ?? '').localeCompare(b.achievedAt ?? '') : 0) ||
    b.publishedAt.localeCompare(a.publishedAt) ||
    (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0)
  );
}

export function rankProducts<T extends RankInput>(rows: T[]): (T & { rank: number })[] {
  return [...rows].sort(compareRank).map((r, i) => ({ ...r, rank: i + 1 }));
}

export interface LoadedRankRow extends RankInput {
  slug: string;
  name: string;
  tagline: string;
  imageUrl: string | null;
  isSample: boolean;
  ownerId: string;
  pageVersionId: string | null;
  productVersion: number;
}

/**
 * Board standings as of instant `atMs`, computed only from rows committed before it, so a
 * snapshot retried later reproduces the same order (A10, A33).
 * - active bid: confirmed contributions with starts_at < at <= expires_at window (rolling 24h/7d/30d)
 * - referrals: owner's successful referrals vested at or before `at`
 * - clicks/views: distinct visitors in the 30 days ending at `at`
 */
export async function loadStandings(db: D1Database, board: Board, atMs: number): Promise<(LoadedRankRow & { rank: number })[]> {
  const at = iso(atMs);
  const from = iso(atMs - METRIC_WINDOW_MS);
  const { results } = await db.prepare(`
    WITH active AS (
      SELECT product_id, SUM(rank_units) AS amt, MAX(starts_at) AS achieved
      FROM bid_contributions
      WHERE board = ?1 AND starts_at < ?2 AND expires_at > ?2
        AND (status = 'active' OR voided_at > ?2)
      GROUP BY product_id
    ),
    refs AS (
      SELECT referrer_user_id AS uid, COUNT(*) AS n FROM successful_referrals
      WHERE status = 'vested' AND vested_at <= ?2 GROUP BY referrer_user_id
    ),
    clicks AS (
      SELECT product_id, COUNT(DISTINCT visitor_hash) AS n FROM measurement_events
      WHERE event_type IN ('product_card_click', 'outbound_click') AND occurred_at > ?3 AND occurred_at <= ?2
      GROUP BY product_id
    ),
    views AS (
      SELECT product_id, COUNT(DISTINCT visitor_hash) AS n FROM measurement_events
      WHERE event_type = 'product_page_view' AND occurred_at > ?3 AND occurred_at <= ?2
      GROUP BY product_id
    )
    SELECT p.id, p.slug, p.name, p.tagline, p.image_url, p.is_sample, p.owner_id, p.published_at,
           p.current_page_version_id, p.version,
           COALESCE(a.amt, 0) AS amt, a.achieved, COALESCE(r.n, 0) AS refs,
           COALESCE(c.n, 0) AS clicks, COALESCE(v.n, 0) AS views
    FROM products p
    LEFT JOIN active a ON a.product_id = p.id
    LEFT JOIN refs r ON r.uid = p.owner_id
    LEFT JOIN clicks c ON c.product_id = p.id
    LEFT JOIN views v ON v.product_id = p.id
    WHERE p.status = 'published' AND p.published_at <= ?2
  `).bind(board, at, from).all<Record<string, unknown>>();

  return rankProducts(results.map(r => ({
    productId: r.id as string,
    slug: r.slug as string,
    name: r.name as string,
    tagline: r.tagline as string,
    imageUrl: (r.image_url as string) ?? null,
    isSample: r.is_sample === 1,
    ownerId: r.owner_id as string,
    pageVersionId: (r.current_page_version_id as string) ?? null,
    productVersion: r.version as number,
    publishedAt: r.published_at as string,
    activeRankUnits: r.amt as number,
    achievedAt: (r.achieved as string) ?? null,
    ownerSuccessfulReferrals: r.refs as number,
    validClicks: r.clicks as number,
    validViews: r.views as number,
  })));
}
