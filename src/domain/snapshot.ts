// The 03:12 ICT lock: freeze three boards, finalize three revenue cohorts, plan ad flights and
// produce mock media. Every step is keyed by (board, cutoff) so retries and late runs are no-ops (A10).
import { sha256Hex } from '../lib/crypto';
import { newId } from '../lib/ids';
import { DAY_MS, cutoffAtOrBefore, ictDate, iso } from '../lib/time';
import { type Board, BOARD_DAYS, BOARDS, METRIC_WINDOW_MS, RANKING_POLICY_VERSION, TOP_N } from './config';
import { isConstraintError } from './errors';
import { acct, outboxStatement, postingStatements } from './ledger';
import { loadStandings } from './ranking';

export const MEDIA_PLATFORMS = ['x', 'facebook', 'youtube'] as const;

export async function getSnapshot(db: D1Database, board: Board, cutoffMs: number) {
  return db.prepare('SELECT * FROM board_snapshots WHERE board = ? AND cutoff_at = ?').bind(board, iso(cutoffMs))
    .first<{ id: string; board: Board; cutoff_at: string; executed_at: string; ranking_policy_version: string; ranking_metric_window: string }>();
}

/** Freeze one board at an explicit cutoff. Uses only data committed before the cutoff; idempotent. */
export async function freezeBoard(db: D1Database, board: Board, cutoffMs: number, nowMs = Date.now()) {
  const existing = await getSnapshot(db, board, cutoffMs);
  if (existing) return { snapshotId: existing.id, created: false };
  const rows = await loadStandings(db, board, cutoffMs);
  const id = newId('snp');
  const now = iso(nowMs);
  try {
    await db.batch([
      db.prepare(`INSERT INTO board_snapshots (id, board, cutoff_at, executed_at, ranking_policy_version, ranking_metric_window, status)
                  VALUES (?, ?, ?, ?, ?, ?, 'frozen')`).bind(id, board, iso(cutoffMs), now, RANKING_POLICY_VERSION, `rolling_${METRIC_WINDOW_MS / DAY_MS}d`),
      ...rows.map(r => db.prepare(`INSERT INTO board_snapshot_items (snapshot_id, rank, product_id, page_version_id, product_metadata_version, rank_units,
            owner_successful_referrals, valid_unique_clicks, valid_unique_views, visibility_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible')`)
        .bind(id, r.rank, r.productId, r.pageVersionId, r.productVersion, r.activeRankUnits, r.ownerSuccessfulReferrals, r.validClicks, r.validViews)),
      outboxStatement(db, 'BoardSnapshotFrozen', id, { board, cutoffAt: iso(cutoffMs), items: rows.length }, now),
    ]);
    return { snapshotId: id, created: true };
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    const raced = await getSnapshot(db, board, cutoffMs);
    if (raced) return { snapshotId: raced.id, created: false };
    throw e;
  }
}

/**
 * Finalize the revenue cohort of (board, cutoff): contributions confirmed after the previous
 * cutoff and before this one, each allocated exactly once (UNIQUE bid_contribution_id). Old
 * contributions that are still active never fund a new cohort (A09).
 */
export async function finalizeCohort(db: D1Database, board: Board, cutoffMs: number, nowMs = Date.now()) {
  const cutoff = iso(cutoffMs);
  const done = await db.prepare('SELECT id, currency FROM revenue_cohorts WHERE board = ? AND cutoff_at = ?').bind(board, cutoff).all<{ id: string; currency: string }>();
  if (done.results.length) return { created: false, cohorts: done.results.map(r => r.id) };
  const { results } = await db.prepare(`SELECT c.id, c.currency, c.gross_minor, c.ads_minor, c.commission_minor, c.platform_minor, p.wallet_minor
      FROM bid_contributions c JOIN payments p ON p.bid_intent_id = c.bid_intent_id
      WHERE c.board = ? AND c.assigned_cutoff_at = ? AND c.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM revenue_cohort_contributions rc WHERE rc.bid_contribution_id = c.id)`).bind(board, cutoff)
    .all<{ id: string; currency: string; gross_minor: number; ads_minor: number; commission_minor: number; platform_minor: number; wallet_minor: number }>();

  const byCurrency = new Map<string, typeof results>();
  for (const r of results) byCurrency.set(r.currency, [...(byCurrency.get(r.currency) ?? []), r]);
  // A day without new revenue still gets a (zero) cohort so the record shows that no new ad budget exists.
  if (!byCurrency.size) byCurrency.set('USD', []);

  const now = iso(nowMs);
  const statements: D1PreparedStatement[] = [];
  const ids: string[] = [];
  for (const [currency, rows] of byCurrency) {
    const sum = (k: 'gross_minor' | 'ads_minor' | 'commission_minor' | 'platform_minor' | 'wallet_minor') => rows.reduce((a, r) => a + r[k], 0);
    const gross = sum('gross_minor'), ads = sum('ads_minor'), com = sum('commission_minor'), plat = sum('platform_minor'), wallet = sum('wallet_minor');
    const cohortId = newId('coh');
    ids.push(cohortId);
    statements.push(
      db.prepare(`INSERT INTO revenue_cohorts (id, board, cutoff_at, currency, eligible_revenue_minor, external_cash_minor, wallet_funded_minor,
          ads_fund_minor, referral_commission_minor, operator_allocation_minor, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'finalized', ?)`)
        .bind(cohortId, board, cutoff, currency, gross, gross - wallet, wallet, ads, com, plat, now),
      ...rows.map(r => db.prepare(`INSERT INTO revenue_cohort_contributions (cohort_id, bid_contribution_id, allocated_amount_minor, ads_minor) VALUES (?, ?, ?, ?)`)
        .bind(cohortId, r.id, r.gross_minor, r.ads_minor)),
      outboxStatement(db, 'RevenueCohortFinalized', cohortId, { board, cutoffAt: cutoff, currency, gross, ads }, now),
    );
    if (ads > 0) {
      const days = BOARD_DAYS[board];
      statements.push(
        ...postingStatements(db, { kind: 'cohort_fund', referenceId: cohortId, memo: `${board} cohort ${ictDate(cutoffMs)} ${currency}`, entries: [
          { account: acct.adsPending(board), currency, amount: ads },
          { account: acct.adsFund(board), currency, amount: -ads },
        ] }, now),
        // Phase 4 (ad execution) is out of scope: the flight is planned with hard caps; the adapter is a mock.
        db.prepare(`INSERT INTO ad_flights (id, cohort_id, board, currency, start_at, end_at, spend_cap_minor, daily_cap_minor, state, adapter_status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', 'mocked', ?)`)
          .bind(newId('fli'), cohortId, board, currency, cutoff, iso(cutoffMs + days * DAY_MS), ads, Math.floor(ads / days), now),
        db.prepare(`UPDATE revenue_cohorts SET status = 'funded' WHERE id = ?`).bind(cohortId),
      );
    }
  }
  try {
    await db.batch(statements);
    return { created: true, cohorts: ids };
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    return { created: false, cohorts: [] };
  }
}

/** Video/social adapters are mocks in this MVP: they record a deterministic composition and an explicit "mocked" status. */
export async function produceMockMedia(db: D1Database, snapshotId: string, origin: string, nowMs = Date.now()) {
  const snap = await db.prepare('SELECT board, cutoff_at FROM board_snapshots WHERE id = ?').bind(snapshotId).first<{ board: Board; cutoff_at: string }>();
  if (!snap) return;
  const { results } = await db.prepare(`SELECT i.rank, p.slug, p.name, i.rank_units FROM board_snapshot_items i JOIN products p ON p.id = i.product_id
      WHERE i.snapshot_id = ? AND i.rank <= ? AND i.visibility_state = 'visible' ORDER BY i.rank`).bind(snapshotId, TOP_N).all();
  const date = ictDate(Date.parse(snap.cutoff_at));
  const snapshotUrl = `${origin}/s/${snap.board}/${date}`;
  const composition = JSON.stringify({ template: 'top10-v1', board: snap.board, date, snapshotUrl, items: results });
  const hash = await sha256Hex(composition);
  const now = iso(nowMs);
  await db.batch([
    db.prepare(`INSERT INTO content_assets (id, snapshot_id, type, url, content_hash, status, created_at) VALUES (?, ?, 'video_composition', ?, ?, 'mocked', ?)
                ON CONFLICT (snapshot_id, type) DO NOTHING`).bind(newId('ast'), snapshotId, `${snapshotUrl}.json`, hash, now),
    ...MEDIA_PLATFORMS.map(p => db.prepare(`INSERT INTO social_publications (id, snapshot_id, platform, external_post_id, url, state, created_at)
                VALUES (?, ?, ?, NULL, NULL, 'mocked', ?) ON CONFLICT (snapshot_id, platform) DO NOTHING`).bind(newId('pub'), snapshotId, p, now)),
  ]);
}

/** Full lock for one cutoff. Job-level idempotency via job_runs; each step is also idempotent on its own. */
export async function runLock(db: D1Database, origin: string, cutoffMs: number, nowMs = Date.now()) {
  const version = RANKING_POLICY_VERSION;
  const resource = iso(cutoffMs);
  const prior = await db.prepare(`SELECT status FROM job_runs WHERE job_type = 'daily_lock' AND resource_id = ? AND version = ?`).bind(resource, version).first<{ status: string }>();
  if (prior?.status === 'done') return { cutoffAt: resource, skipped: true };
  await db.prepare(`INSERT INTO job_runs (job_type, resource_id, version, status, started_at) VALUES ('daily_lock', ?, ?, 'running', ?)
                    ON CONFLICT (job_type, resource_id, version) DO UPDATE SET status = 'running', started_at = excluded.started_at`).bind(resource, version, iso(nowMs)).run();
  const result: Record<string, unknown> = {};
  for (const board of BOARDS) {
    const snap = await freezeBoard(db, board, cutoffMs, nowMs);
    const cohort = await finalizeCohort(db, board, cutoffMs, nowMs);
    await produceMockMedia(db, snap.snapshotId, origin, nowMs);
    result[board] = { snapshot: snap, cohort };
  }
  await db.prepare(`UPDATE job_runs SET status = 'done', finished_at = ?, detail = ? WHERE job_type = 'daily_lock' AND resource_id = ? AND version = ?`)
    .bind(iso(nowMs), JSON.stringify(result), resource, version).run();
  return { cutoffAt: resource, skipped: false, result };
}

/** Catch up: lock the latest cutoff and any of the previous `lookbackDays` that were missed (late or failed runs). */
export async function runDueLocks(db: D1Database, origin: string, nowMs = Date.now(), lookbackDays = 2) {
  const latest = cutoffAtOrBefore(nowMs);
  const out = [];
  for (let d = lookbackDays; d >= 0; d--) out.push(await runLock(db, origin, latest - d * DAY_MS, nowMs));
  return out;
}
