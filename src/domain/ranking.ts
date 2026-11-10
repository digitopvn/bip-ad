// Ranking policy rank-v1 (brief section 3.1). Pay-to-win is absolute: referrals, clicks and
// views only break ties between equal active bids, including the zero-bid free group.
import { HOUR_MS, iso } from '../lib/time';
import { type Board, METRIC_WINDOW_MS } from './config';
import { isConstraintError } from './errors';

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
  /** Current status. A board as of a cutoff can hold a product suspended after that cutoff. */
  status: string;
  pageVersionId: string | null;
  productVersion: number;
}

/** How measurement rows are filtered before counting: bot-filtered, owners excluded, one row per visitor per ICT day. */
export const METRIC_FILTER_VERSION = 'visitor-day-dedup-v1';
/** The hourly cron skips its rollup when the latest set is younger than this (a repeated or concurrent run). */
const ROLLUP_MIN_INTERVAL_MS = HOUR_MS / 2;
/** Hourly sets older than this are pruned when a new one is written; cutoff sets are kept. */
const HOURLY_ROLLUP_RETENTION_MS = 24 * HOUR_MS;

/**
 * Statements that write the metric set ending at `asOfMs`: distinct visitors with a card or
 * outbound click, and distinct page-view visitors, in the 30 days ending at that instant (the
 * same window and filters as ADR-0002 keys 3 and 4). A single INSERT ... SELECT, so the set costs
 * one statement however many products there are. The header insert fails on a duplicate
 * as_of_at, which rolls the whole batch back.
 */
function rollupStatements(db: D1Database, asOfMs: number, kind: 'hourly' | 'cutoff', nowMs: number) {
  const asOf = iso(asOfMs);
  const from = iso(asOfMs - METRIC_WINDOW_MS);
  return [
    db.prepare(`INSERT INTO ranking_metric_rollup_runs (as_of_at, window_start, kind, filter_version, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(asOf, from, kind, METRIC_FILTER_VERSION, iso(nowMs)),
    db.prepare(`INSERT INTO ranking_metric_rollups (as_of_at, product_id, valid_unique_clicks, valid_unique_views)
      SELECT ?1, product_id,
             COUNT(DISTINCT CASE WHEN event_type IN ('product_card_click', 'outbound_click') THEN visitor_hash END),
             COUNT(DISTINCT CASE WHEN event_type = 'product_page_view' THEN visitor_hash END)
      FROM measurement_events
      WHERE event_type IN ('product_card_click', 'outbound_click', 'product_page_view') AND occurred_at > ?2 AND occurred_at <= ?1
      GROUP BY product_id`).bind(asOf, from),
  ];
}

/**
 * Hourly rollup for the live boards, ending at `nowMs`; prunes hourly sets older than a day.
 * Two queries, or one when a set younger than half an hour already exists.
 */
export async function refreshMetricRollup(db: D1Database, nowMs = Date.now()) {
  const latest = await db.prepare('SELECT MAX(as_of_at) AS at FROM ranking_metric_rollup_runs WHERE as_of_at <= ?').bind(iso(nowMs)).first<{ at: string | null }>();
  if (latest?.at && Date.parse(latest.at) > nowMs - ROLLUP_MIN_INTERVAL_MS) return { created: false, asOfAt: latest.at };
  const stale = iso(nowMs - HOURLY_ROLLUP_RETENTION_MS);
  try {
    await db.batch([
      ...rollupStatements(db, nowMs, 'hourly', nowMs),
      db.prepare(`DELETE FROM ranking_metric_rollups WHERE as_of_at IN (SELECT as_of_at FROM ranking_metric_rollup_runs WHERE kind = 'hourly' AND as_of_at < ?)`).bind(stale),
      db.prepare(`DELETE FROM ranking_metric_rollup_runs WHERE kind = 'hourly' AND as_of_at < ?`).bind(stale),
    ]);
    return { created: true, asOfAt: iso(nowMs) };
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    return { created: false, asOfAt: iso(nowMs) };
  }
}

/**
 * The metric set stamped at a cutoff. Written once and kept, so a snapshot taken late or retried
 * reads exactly the scores of 03:12 (A33). One query when it exists, two when it is written.
 */
export async function ensureCutoffRollup(db: D1Database, cutoffMs: number, nowMs = Date.now()) {
  const at = iso(cutoffMs);
  const run = await db.prepare('SELECT kind FROM ranking_metric_rollup_runs WHERE as_of_at = ?').bind(at).first<{ kind: string }>();
  if (run?.kind === 'cutoff') return;
  if (run) {
    // An hourly set ending exactly at the cutoff has the same counts: keep it as the cutoff set.
    await db.prepare(`UPDATE ranking_metric_rollup_runs SET kind = 'cutoff' WHERE as_of_at = ?`).bind(at).run();
    return;
  }
  try {
    await db.batch(rollupStatements(db, cutoffMs, 'cutoff', nowMs));
  } catch (e) {
    // Another run wrote it first; both computed the same counts from rows before the cutoff.
    if (!isConstraintError(e)) throw e;
  }
}

/**
 * Board standings at instant `atMs` (ADR-0002). `eligibleCte` defines `eligible(product_id,
 * page_version_id, product_version)`: the products on the board and the versions to pin.
 * - active bid: contributions with starts_at < at < expires_at, not voided by then (live, indexed)
 * - referrals: owner's successful referrals vested at or before `at` (live)
 * - clicks/views: the latest metric set ending at or before `at` (ranking_metric_rollups)
 */
async function standings(db: D1Database, board: Board, atMs: number, eligibleCte: string) {
  const { results } = await db.prepare(`
    WITH ${eligibleCte},
    active AS (
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
    metrics AS (
      SELECT product_id, valid_unique_clicks AS clicks, valid_unique_views AS views FROM ranking_metric_rollups
      WHERE as_of_at = (SELECT MAX(as_of_at) FROM ranking_metric_rollup_runs WHERE as_of_at <= ?2)
    )
    SELECT p.id, p.slug, p.name, p.tagline, p.image_url, p.is_sample, p.owner_id, p.published_at, p.status,
           e.page_version_id, e.product_version,
           COALESCE(a.amt, 0) AS amt, a.achieved, COALESCE(r.n, 0) AS refs,
           COALESCE(m.clicks, 0) AS clicks, COALESCE(m.views, 0) AS views
    FROM eligible e
    JOIN products p ON p.id = e.product_id
    LEFT JOIN active a ON a.product_id = p.id
    LEFT JOIN refs r ON r.uid = p.owner_id
    LEFT JOIN metrics m ON m.product_id = p.id
    WHERE p.published_at <= ?2
  `).bind(board, iso(atMs)).all<Record<string, unknown>>();

  return rankProducts(results.map(r => ({
    productId: r.id as string,
    slug: r.slug as string,
    name: r.name as string,
    tagline: r.tagline as string,
    imageUrl: (r.image_url as string) ?? null,
    isSample: r.is_sample === 1,
    ownerId: r.owner_id as string,
    status: r.status as string,
    pageVersionId: (r.page_version_id as string) ?? null,
    productVersion: r.product_version as number,
    publishedAt: r.published_at as string,
    activeRankUnits: r.amt as number,
    achievedAt: (r.achieved as string) ?? null,
    ownerSuccessfulReferrals: r.refs as number,
    validClicks: r.clicks as number,
    validViews: r.views as number,
  })));
}

/**
 * Live board at `atMs`: currently published products with their live page. Click/view counts come
 * from the latest rollup (written hourly and at each cutoff), never from raw measurement rows.
 */
export async function loadStandings(db: D1Database, board: Board, atMs: number): Promise<(LoadedRankRow & { rank: number })[]> {
  return standings(db, board, atMs, `eligible AS (
      SELECT id AS product_id, current_page_version_id AS page_version_id, version AS product_version FROM products WHERE status = 'published'
    )`);
}

/**
 * Board as of a cutoff, for the snapshot: products whose state at the cutoff was published (even
 * when suspended since), pinned to the page and product version live at the cutoff, and scored
 * from the metric set stamped at the cutoff. Reads only rows committed before the cutoff, so a
 * late or retried run reproduces the same order (A10, A33).
 */
export async function loadCutoffStandings(db: D1Database, board: Board, cutoffMs: number, nowMs = Date.now()): Promise<(LoadedRankRow & { rank: number })[]> {
  await ensureCutoffRollup(db, cutoffMs, nowMs);
  return standings(db, board, cutoffMs, `state AS (
      SELECT product_id, status, page_version_id, product_version,
             ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY changed_at DESC, id DESC) AS n
      FROM product_state_history WHERE changed_at <= ?2
    ),
    eligible AS (SELECT product_id, page_version_id, product_version FROM state WHERE n = 1 AND status = 'published')`);
}
