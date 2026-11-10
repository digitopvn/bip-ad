import { describe, expect, it } from 'vitest';
import { finalizeCohort, freezeBoard, runLock } from '../src/domain/snapshot';
import { recordEvent } from '../src/domain/measurement';
import { cutoffAtOrBefore, cutoffForIctDate, DAY_MS, ictDate, iso, nextCutoffAfter } from '../src/lib/time';
import { bid, db, E, ledgerBalancedEverywhere, makeProduct, makeUser } from './helpers';
import { scheduledJob } from '../src/index';

describe('03:12 ICT time math', () => {
  it('cutoff is 20:12 UTC of the previous day; a payment at exactly 03:12:00 belongs to the next cohort', () => {
    const c = cutoffForIctDate('2026-11-08');
    expect(iso(c)).toBe('2026-11-07T20:12:00.000Z');
    expect(nextCutoffAfter(c - 1)).toBe(c);
    expect(nextCutoffAfter(c)).toBe(c + DAY_MS);
    expect(nextCutoffAfter(c + 1000)).toBe(c + DAY_MS); // A11: 03:12:01 → tomorrow
    expect(cutoffAtOrBefore(c + 5 * 3600_000)).toBe(c);
    expect(ictDate(c)).toBe('2026-11-08');
  });
});

describe('daily lock', () => {
  const C1 = cutoffForIctDate('2032-02-10');

  it('A08/A09/A11: weekly $100 before cutoff funds that cohort once ($80 ads); next day the still-active bid adds $0; a 03:12:01 bid goes to the next cohort', async () => {
    const u = await makeUser();
    const p = await makeProduct(u, 'Weekly Hundred');
    await bid(u, p, 'weekly', 10000, C1 - 60_000); // 03:11
    await bid(u, p, 'weekly', 2000, C1 + 1000); // 03:12:01
    await runLock(db(), 'https://bip.test', C1, C1 + 5000);
    const c1 = await db().prepare(`SELECT eligible_revenue_minor, ads_fund_minor FROM revenue_cohorts WHERE board = 'weekly' AND cutoff_at = ? AND currency = 'USD'`).bind(iso(C1)).first();
    expect(c1).toEqual({ eligible_revenue_minor: 10000, ads_fund_minor: 8000 });
    // Snapshot at C1 shows the $100 but not the 03:12:01 bid.
    const item = await db().prepare(`SELECT i.rank_units FROM board_snapshot_items i JOIN board_snapshots s ON s.id = i.snapshot_id WHERE s.board = 'weekly' AND s.cutoff_at = ? AND i.product_id = ?`).bind(iso(C1), p).first();
    expect(item).toEqual({ rank_units: 10000 });

    const C2 = C1 + DAY_MS;
    await runLock(db(), 'https://bip.test', C2, C2 + 5000);
    const c2 = await db().prepare(`SELECT eligible_revenue_minor, ads_fund_minor FROM revenue_cohorts WHERE board = 'weekly' AND cutoff_at = ? AND currency = 'USD'`).bind(iso(C2)).first();
    expect(c2).toEqual({ eligible_revenue_minor: 2000, ads_fund_minor: 1600 }); // only the new $20
    const item2 = await db().prepare(`SELECT i.rank_units FROM board_snapshot_items i JOIN board_snapshots s ON s.id = i.snapshot_id WHERE s.board = 'weekly' AND s.cutoff_at = ? AND i.product_id = ?`).bind(iso(C2), p).first();
    expect(item2).toEqual({ rank_units: 12000 }); // the old $100 still ranks
    const allocs = await db().prepare(`SELECT COUNT(*) AS n FROM revenue_cohort_contributions rc JOIN bid_contributions c ON c.id = rc.bid_contribution_id WHERE c.product_id = ?`).bind(p).first<{ n: number }>();
    expect(allocs!.n).toBe(2);
    const C3 = C2 + DAY_MS;
    await runLock(db(), 'https://bip.test', C3, C3 + 5000);
    const c3 = await db().prepare(`SELECT ads_fund_minor FROM revenue_cohorts WHERE board = 'weekly' AND cutoff_at = ?`).bind(iso(C3)).all();
    expect(c3.results.every(r => r.ads_fund_minor === 0)).toBe(true); // A09
    const flights = await db().prepare(`SELECT COUNT(*) AS n FROM ad_flights f JOIN revenue_cohorts c ON c.id = f.cohort_id WHERE c.cutoff_at = ? AND c.board = 'weekly'`).bind(iso(C3)).first<{ n: number }>();
    expect(flights!.n).toBe(0); // no $0 campaign
    expect(await ledgerBalancedEverywhere()).toBe(true);
  });

  it('A10: running the lock twice, late, or step by step creates one snapshot and one allocation per board/cutoff', async () => {
    const C = cutoffForIctDate('2032-03-01');
    const u = await makeUser();
    const p = await makeProduct(u, 'Twice');
    await bid(u, p, 'daily', 3000, C - 3600_000);
    await runLock(db(), 'https://bip.test', C, C + 3 * 3600_000); // three hours late
    await runLock(db(), 'https://bip.test', C, C + 4 * 3600_000);
    await freezeBoard(db(), 'daily', C);
    await finalizeCohort(db(), 'daily', C);
    const snaps = await db().prepare('SELECT COUNT(*) AS n, MIN(executed_at) AS e FROM board_snapshots WHERE cutoff_at = ?').bind(iso(C)).first<{ n: number; e: string }>();
    expect(snaps!.n).toBe(3);
    expect(snaps!.e).toBe(iso(C + 3 * 3600_000)); // actual execution time recorded separately from cutoff
    const cohorts = await db().prepare(`SELECT COUNT(*) AS n FROM revenue_cohorts WHERE cutoff_at = ? AND board = 'daily'`).bind(iso(C)).first<{ n: number }>();
    expect(cohorts!.n).toBe(1);
    const media = await db().prepare(`SELECT COUNT(*) AS n FROM social_publications sp JOIN board_snapshots s ON s.id = sp.snapshot_id WHERE s.cutoff_at = ? AND sp.state = 'mocked'`).bind(iso(C)).first<{ n: number }>();
    expect(media!.n).toBe(9); // 3 boards × X/Facebook/YouTube, all mocked, no duplicates
  });

  it('A33: a score bump right after the cutoff does not change a late or retried snapshot', async () => {
    const C = cutoffForIctDate('2032-04-01');
    const u1 = await makeUser();
    const u2 = await makeUser();
    const a = await makeProduct(u1, 'Determ A');
    const b = await makeProduct(u2, 'Determ B');
    await recordEvent(db(), { productId: a, type: 'outbound_click', visitor: 'x1', source: 't', nowMs: C - 10_000 });
    // After the cutoff, B gets more clicks and a bid; the late job must ignore both.
    for (const v of ['y1', 'y2', 'y3']) await recordEvent(db(), { productId: b, type: 'outbound_click', visitor: v, source: 't', nowMs: C + 1000 });
    await bid(u2, b, 'monthly', 5000, C + 2000);
    await freezeBoard(db(), 'monthly', C, C + 3600_000);
    const rows = await db().prepare(`SELECT i.product_id, i.rank FROM board_snapshot_items i JOIN board_snapshots s ON s.id = i.snapshot_id WHERE s.board = 'monthly' AND s.cutoff_at = ? AND i.product_id IN (?, ?) ORDER BY i.rank`).bind(iso(C), a, b).all<{ product_id: string }>();
    expect(rows.results.map(r => r.product_id)).toEqual([a, b]);
  });

  it('A17: snapshot items are immutable; only removal from publication is allowed', async () => {
    const C = cutoffForIctDate('2032-05-01');
    const u = await makeUser();
    const p = await makeProduct(u, 'Immutable');
    await bid(u, p, 'daily', 1000, C - 1000);
    const { snapshotId } = await freezeBoard(db(), 'daily', C, C + 1);
    await expect(db().prepare('UPDATE board_snapshot_items SET rank_units = 1 WHERE snapshot_id = ? AND product_id = ?').bind(snapshotId, p).run()).rejects.toThrow(/immutable/);
    await expect(db().prepare('DELETE FROM board_snapshot_items WHERE snapshot_id = ?').bind(snapshotId).run()).rejects.toThrow(/immutable/);
    await db().prepare(`UPDATE board_snapshot_items SET visibility_state = 'removed_from_publication' WHERE snapshot_id = ? AND product_id = ?`).bind(snapshotId, p).run();
    await expect(db().prepare(`UPDATE board_snapshot_items SET visibility_state = 'visible' WHERE snapshot_id = ? AND product_id = ?`).bind(snapshotId, p).run()).rejects.toThrow(/immutable/);
  });

  it('A04: #11 that paid is kept on the listing, outside the Top 10 media composition, and not refunded', async () => {
    const C = cutoffForIctDate('2032-06-01');
    const u = await makeUser();
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const p = await makeProduct(u, `Eleven ${i}`);
      ids.push(p);
      await bid(u, p, 'daily', 100000 - i * 1000, C - 3600_000 + i);
    }
    await runLock(db(), 'https://bip.test', C, C + 1);
    const eleventh = await db().prepare(`SELECT i.rank FROM board_snapshot_items i JOIN board_snapshots s ON s.id = i.snapshot_id WHERE s.board = 'daily' AND s.cutoff_at = ? AND i.product_id = ?`).bind(iso(C), ids[10]).first<{ rank: number }>();
    expect(eleventh!.rank).toBeGreaterThan(10);
    const pay = await db().prepare(`SELECT state FROM payments p JOIN bid_intents i ON i.id = p.bid_intent_id WHERE i.product_id = ?`).bind(ids[10]).first<{ state: string }>();
    expect(pay!.state).toBe('captured');
  });

  it('the scheduled job vests, expires and locks idempotently', async () => {
    const now = cutoffForIctDate('2032-07-01') + 60_000;
    const r1 = await scheduledJob(E, now);
    expect(r1.at(-1)!.skipped).toBe(false);
    // A full catch-up does not fit one invocation's query budget: following hourly runs finish it.
    let hour = 1;
    for (let r = r1; !r.every(x => x.complete); hour++) {
      expect(hour).toBeLessThan(6);
      r = await scheduledJob(E, now + hour * 3600_000);
    }
    const r2 = await scheduledJob(E, now + hour * 3600_000);
    expect(r2.every(x => x.skipped)).toBe(true);
  });
});
