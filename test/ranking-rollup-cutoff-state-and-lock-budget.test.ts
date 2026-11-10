import { afterEach, describe, expect, it, vi } from 'vitest';
import { meteredDb, QueryBudget } from '../src/email/d1-query-meter';
import { METRIC_WINDOW_MS } from '../src/domain/config';
import { recordEvent } from '../src/domain/measurement';
import { moderateProduct, publishPage, setBlocks } from '../src/domain/products';
import { compareRank, loadCutoffStandings, loadStandings, refreshMetricRollup } from '../src/domain/ranking';
import { freezeBoard, LOCK_STEP_QUERIES, runDueLocks } from '../src/domain/snapshot';
import { SCHEDULED_QUERY_CAP, scheduledJob } from '../src/index';
import { newId } from '../src/lib/ids';
import { cutoffForIctDate, DAY_MS, HOUR_MS, iso } from '../src/lib/time';
import { bid, cfg, db, E, makeProduct, makeUser } from './helpers';

/** The per-request aggregation live boards used before the rollup: the reference the rollup must reproduce. */
async function rawAggregation(atMs: number) {
  const { results } = await db().prepare(`
    WITH active AS (
      SELECT product_id, SUM(rank_units) AS amt, MAX(starts_at) AS achieved FROM bid_contributions
      WHERE board = 'daily' AND starts_at < ?1 AND expires_at > ?1 AND (status = 'active' OR voided_at > ?1) GROUP BY product_id
    ),
    refs AS (SELECT referrer_user_id AS uid, COUNT(*) AS n FROM successful_referrals WHERE status = 'vested' AND vested_at <= ?1 GROUP BY referrer_user_id),
    clicks AS (SELECT product_id, COUNT(DISTINCT visitor_hash) AS n FROM measurement_events
      WHERE event_type IN ('product_card_click', 'outbound_click') AND occurred_at > ?2 AND occurred_at <= ?1 GROUP BY product_id),
    views AS (SELECT product_id, COUNT(DISTINCT visitor_hash) AS n FROM measurement_events
      WHERE event_type = 'product_page_view' AND occurred_at > ?2 AND occurred_at <= ?1 GROUP BY product_id)
    SELECT p.id, p.published_at, COALESCE(a.amt, 0) AS amt, a.achieved, COALESCE(r.n, 0) AS refs, COALESCE(c.n, 0) AS clicks, COALESCE(v.n, 0) AS views
    FROM products p LEFT JOIN active a ON a.product_id = p.id LEFT JOIN refs r ON r.uid = p.owner_id
    LEFT JOIN clicks c ON c.product_id = p.id LEFT JOIN views v ON v.product_id = p.id
    WHERE p.status = 'published' AND p.published_at <= ?1`).bind(iso(atMs), iso(atMs - METRIC_WINDOW_MS)).all<Record<string, unknown>>();
  return results.map(r => ({
    productId: r.id as string, publishedAt: r.published_at as string, activeRankUnits: r.amt as number, achievedAt: (r.achieved as string) ?? null,
    ownerSuccessfulReferrals: r.refs as number, validClicks: r.clicks as number, validViews: r.views as number,
  })).sort(compareRank);
}

const pick = (rows: { productId: string; activeRankUnits: number; validClicks: number; validViews: number }[], ids: string[]) =>
  rows.filter(r => ids.includes(r.productId)).map(r => [r.productId, r.activeRankUnits, r.validClicks, r.validViews]);

describe('ranking metric rollups', () => {
  it('rollup-backed standings order and count exactly like the raw 30-day aggregation', async () => {
    const at = Date.parse('2036-01-20T05:00:00Z');
    const owners: string[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      owners.push(await makeUser());
      ids.push(await makeProduct(owners[i], `Rollup Eq ${i}`, at - 60 * DAY_MS + i * HOUR_MS));
    }
    // Equal bids on two products, so clicks and views decide between them; the rest are free.
    await bid(owners[0], ids[0], 'daily', 500, at - 2 * HOUR_MS);
    await bid(owners[1], ids[1], 'daily', 500, at - 3 * HOUR_MS);
    const ev = (p: string, type: 'outbound_click' | 'product_card_click' | 'product_page_view' | 'product_card_impression', visitor: string, nowMs: number) =>
      recordEvent(db(), { productId: p, type, visitor, source: 'test', nowMs });
    await ev(ids[1], 'outbound_click', 'a', at - DAY_MS);
    await ev(ids[1], 'product_card_click', 'a', at - DAY_MS); // same visitor via another click type counts once
    await ev(ids[2], 'product_page_view', 'a', at - DAY_MS);
    await ev(ids[2], 'product_page_view', 'b', at - 2 * DAY_MS);
    await ev(ids[3], 'product_page_view', 'a', at - DAY_MS);
    await ev(ids[3], 'outbound_click', 'z', at - METRIC_WINDOW_MS - HOUR_MS); // outside the window
    await ev(ids[4], 'product_card_impression', 'a', at - DAY_MS); // impressions never rank
    await ev(ids[5], 'outbound_click', 'late', at + 1000); // after the instant
    await ev(ids[5], 'outbound_click', 'edge', at); // exactly at the window end counts

    await refreshMetricRollup(db(), at);
    const live = await loadStandings(db(), 'daily', at);
    const raw = await rawAggregation(at);
    expect(pick(live, ids)).toEqual(pick(raw, ids));
    expect(live.map(r => r.productId)).toEqual(raw.map(r => r.productId));
    expect(pick(live, [ids[1], ids[2], ids[5]])).toEqual([[ids[1], 500, 1, 0], [ids[5], 0, 1, 0], [ids[2], 0, 0, 2]]);
    // The board as of an instant with no state change reads the same.
    expect((await loadCutoffStandings(db(), 'daily', at)).map(r => r.productId)).toEqual(raw.map(r => r.productId));
  });

  it('live boards read the latest set; a run within half an hour is a no-op; hourly sets are pruned, cutoff sets kept', async () => {
    const t = Date.parse('2036-02-10T05:40:00Z');
    const p = await makeProduct(await makeUser(), 'Rollup Fresh', t - 40 * DAY_MS);
    await recordEvent(db(), { productId: p, type: 'outbound_click', visitor: 'v1', source: 'test', nowMs: t - HOUR_MS });
    expect(await refreshMetricRollup(db(), t)).toMatchObject({ created: true });
    const clicks = async (at: number) => (await loadStandings(db(), 'daily', at)).find(r => r.productId === p)!.validClicks;
    expect(await clicks(t)).toBe(1);
    await recordEvent(db(), { productId: p, type: 'outbound_click', visitor: 'v2', source: 'test', nowMs: t + 60_000 });
    expect(await clicks(t + 120_000)).toBe(1); // raw rows are not read per request
    expect(await refreshMetricRollup(db(), t + 20 * 60_000)).toMatchObject({ created: false });
    expect(await refreshMetricRollup(db(), t + HOUR_MS)).toMatchObject({ created: true });
    expect(await clicks(t + HOUR_MS)).toBe(2);

    const cutoff = cutoffForIctDate('2036-02-12');
    await freezeBoard(db(), 'daily', cutoff, cutoff + 1000); // writes the cutoff set
    await refreshMetricRollup(db(), cutoff + 3 * DAY_MS);
    const runs = await db().prepare('SELECT as_of_at, kind FROM ranking_metric_rollup_runs WHERE as_of_at >= ? AND as_of_at <= ? ORDER BY as_of_at')
      .bind(iso(t), iso(cutoff + 3 * DAY_MS)).all<{ as_of_at: string; kind: string }>();
    expect(runs.results).toEqual([{ as_of_at: iso(cutoff), kind: 'cutoff' }, { as_of_at: iso(cutoff + 3 * DAY_MS), kind: 'hourly' }]);
    const orphans = await db().prepare('SELECT COUNT(*) AS n FROM ranking_metric_rollups r LEFT JOIN ranking_metric_rollup_runs h ON h.as_of_at = r.as_of_at WHERE h.as_of_at IS NULL').first<{ n: number }>();
    expect(orphans!.n).toBe(0);
  });
});

describe('snapshot as of the cutoff', () => {
  it('a late first run keeps a product suspended after the cutoff, pins the page live at the cutoff and skips later publications', async () => {
    const C = cutoffForIctDate('2036-03-05');
    const u = await makeUser();
    const suspended = await makeProduct(u, 'Suspended Later');
    const republished = await makeProduct(u, 'Republished Later');
    await bid(u, suspended, 'daily', 3000, C - HOUR_MS);
    await bid(u, republished, 'daily', 2000, C - HOUR_MS);
    const before = (await db().prepare('SELECT current_page_version_id, version FROM products WHERE id = ?').bind(republished).first<{ current_page_version_id: string; version: number }>())!;

    // After the cutoff, before the (late) lock run.
    await moderateProduct(db(), 'operator:test', suspended, 'suspend', 'POLICY_VIOLATION', C + 10 * 60_000);
    await setBlocks(db(), u, republished, [{ type: 'hero', headline: 'Version two' }], C + 20 * 60_000);
    expect(await publishPage(db(), cfg(), u, republished, undefined, C + 21 * 60_000)).toMatchObject({ ok: true, pendingReview: false });
    const after = (await db().prepare('SELECT current_page_version_id, version FROM products WHERE id = ?').bind(republished).first<{ current_page_version_id: string; version: number }>())!;
    expect(after.current_page_version_id).not.toBe(before.current_page_version_id);
    const newcomer = await makeProduct(u, 'Published After Cutoff', C + 30 * 60_000);
    await bid(u, newcomer, 'daily', 9000, C - HOUR_MS); // paid before the cutoff, published after it

    const { snapshotId } = await freezeBoard(db(), 'daily', C, C + 3 * HOUR_MS);
    const items = await db().prepare('SELECT product_id, rank, page_version_id, product_metadata_version, rank_units, visibility_state FROM board_snapshot_items WHERE snapshot_id = ? AND product_id IN (?, ?, ?) ORDER BY rank')
      .bind(snapshotId, suspended, republished, newcomer).all<Record<string, unknown>>();
    expect(items.results.map(i => [i.product_id, i.rank_units, i.visibility_state])).toEqual([
      [suspended, 3000, 'removed_from_publication'],
      [republished, 2000, 'visible'],
    ]);
    expect(items.results[1]).toMatchObject({ page_version_id: before.current_page_version_id, product_metadata_version: before.version });
    // The live board shows the current state.
    const live = await loadStandings(db(), 'daily', C + 3 * HOUR_MS);
    expect(live.some(r => r.productId === suspended)).toBe(false);
    expect(live.find(r => r.productId === republished)!.pageVersionId).toBe(after.current_page_version_id);
  });

  it('a product republished and suspended after a timely snapshot does not change it', async () => {
    const C = cutoffForIctDate('2036-03-06');
    const u = await makeUser();
    const p = await makeProduct(u, 'Timely');
    await bid(u, p, 'daily', 1500, C - HOUR_MS);
    const first = await freezeBoard(db(), 'daily', C, C + 1000);
    await moderateProduct(db(), 'operator:test', p, 'suspend', 'LATER', C + HOUR_MS);
    expect(await freezeBoard(db(), 'daily', C, C + 2 * HOUR_MS)).toEqual({ snapshotId: first.snapshotId, created: false });
  });
});

describe('lock within D1 query limits', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pages the snapshot insert: every ranked product is stored once, in rank order', async () => {
    const C = cutoffForIctDate('2036-04-02');
    const u = await makeUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await makeProduct(u, `Paged ${i}`));
      await bid(u, ids[i], 'weekly', 1000 + i * 100, C - HOUR_MS + i);
    }
    const expected = (await loadCutoffStandings(db(), 'weekly', C)).map(r => [r.rank, r.productId]);
    const { snapshotId, created } = await freezeBoard(db(), 'weekly', C, C + 1000, 2);
    expect(created).toBe(true);
    const stored = await db().prepare('SELECT rank, product_id FROM board_snapshot_items WHERE snapshot_id = ? ORDER BY rank').bind(snapshotId).all<{ rank: number; product_id: string }>();
    expect(stored.results.map(r => [r.rank, r.product_id])).toEqual(expected);
    expect(stored.results.filter(r => ids.includes(r.product_id)).map(r => r.product_id)).toEqual([...ids].reverse());
    expect(await freezeBoard(db(), 'weekly', C, C + 2000, 2)).toEqual({ snapshotId, created: false });
  });

  it('freezes about a thousand products in one batch of paged statements', async () => {
    const C = cutoffForIctDate('2036-04-20');
    const owner = await makeUser();
    const tag = newId('bulk');
    // Published a day before this cutoff only, so other tests' boards never see them.
    await db().prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
      INSERT INTO products (id, owner_id, slug, name, tagline, website_url, status, published_at, created_at, updated_at)
      SELECT ?1 || '_' || i, ?2, ?1 || '-' || i, 'Bulk ' || i, 'Bulk tagline', 'https://example.com', 'published', ?3, ?3, ?3 FROM n`)
      .bind(tag, owner, iso(C - DAY_MS)).run();
    const meter = new QueryBudget(SCHEDULED_QUERY_CAP);
    const { snapshotId } = await freezeBoard(meteredDb(db(), meter), 'monthly', C, C + 1000);
    expect(meter.used).toBeLessThanOrEqual(LOCK_STEP_QUERIES.freeze);
    const n = await db().prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT rank) AS ranks, MIN(rank) AS lo, MAX(rank) AS hi FROM board_snapshot_items WHERE snapshot_id = ?').bind(snapshotId).first<{ n: number; ranks: number; lo: number; hi: number }>();
    const total = (await loadCutoffStandings(db(), 'monthly', C)).length;
    expect(total).toBeGreaterThanOrEqual(1000);
    expect(n).toEqual({ n: total, ranks: total, lo: 1, hi: total });
    // Take them off later boards (recorded in the state history after this cutoff).
    await db().prepare(`UPDATE products SET status = 'suspended', updated_at = ? WHERE id LIKE ?`).bind(iso(C + 2000), `${tag}_%`).run();
  });

  it('a catch-up of three missed cutoffs splits across invocations under the cap and stays idempotent', async () => {
    const now = cutoffForIctDate('2036-05-10') + 30 * 60_000;
    const cutoffs = [2, 1, 0].map(d => cutoffForIctDate('2036-05-10') - d * DAY_MS);
    const u = await makeUser();
    const p = await makeProduct(u, 'Catch Up');
    for (const c of cutoffs) await bid(u, p, 'daily', 1200, c - HOUR_MS);

    const used: number[] = [];
    for (let run = 0; run < 6; run++) {
      const budget = new QueryBudget(SCHEDULED_QUERY_CAP);
      const out = await runDueLocks(meteredDb(db(), budget), 'https://bip.test', now + run * HOUR_MS, undefined, budget);
      used.push(budget.used);
      expect(budget.used).toBeLessThanOrEqual(SCHEDULED_QUERY_CAP);
      if (out.every(x => x.complete)) break;
    }
    expect(used.length).toBeGreaterThan(1);
    // Once done, a run only checks the three job rows.
    const budget = new QueryBudget(SCHEDULED_QUERY_CAP);
    const again = await runDueLocks(meteredDb(db(), budget), 'https://bip.test', now + 7 * HOUR_MS, undefined, budget);
    expect(again.every(x => x.skipped)).toBe(true);
    expect(budget.used).toBe(3);

    for (const c of cutoffs) {
      const snaps = await db().prepare('SELECT COUNT(*) AS n FROM board_snapshots WHERE cutoff_at = ?').bind(iso(c)).first<{ n: number }>();
      expect(snaps!.n).toBe(3);
      const cohorts = await db().prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT board || currency) AS d, COUNT(DISTINCT board) AS boards FROM revenue_cohorts WHERE cutoff_at = ?`).bind(iso(c)).first<{ n: number; d: number; boards: number }>();
      expect(cohorts!.n).toBe(cohorts!.d);
      expect(cohorts!.boards).toBe(3);
      const media = await db().prepare(`SELECT COUNT(*) AS n FROM social_publications sp JOIN board_snapshots s ON s.id = sp.snapshot_id WHERE s.cutoff_at = ?`).bind(iso(c)).first<{ n: number }>();
      expect(media!.n).toBe(9);
      const job = await db().prepare(`SELECT status FROM job_runs WHERE job_type = 'daily_lock' AND resource_id = ?`).bind(iso(c)).first<{ status: string }>();
      expect(job!.status).toBe('done');
      const mine = await db().prepare(`SELECT COUNT(*) AS n FROM revenue_cohort_contributions rc JOIN bid_contributions b ON b.id = rc.bid_contribution_id
          WHERE b.product_id = ? AND b.assigned_cutoff_at = ?`).bind(p, iso(c)).first<{ n: number }>();
      expect(mine!.n).toBe(1);
    }
  });

  it('every scheduled invocation stays under the query cap', async () => {
    const log = vi.spyOn(console, 'log');
    const now = cutoffForIctDate('2036-06-10') + 5 * 60_000;
    const u = await makeUser();
    await bid(u, await makeProduct(u, 'Scheduled Cap'), 'monthly', 800, now - DAY_MS);
    for (let hour = 0; hour < 5; hour++) await scheduledJob(E, now + hour * HOUR_MS);
    const counts = log.mock.calls.filter(c => c[0] === 'scheduled queries').map(c => c[1] as number);
    expect(counts).toHaveLength(5);
    for (const n of counts) expect(n).toBeLessThanOrEqual(SCHEDULED_QUERY_CAP);
  });
});
