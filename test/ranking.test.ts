import { describe, expect, it } from 'vitest';
import { compareRank, loadStandings, rankProducts, type RankInput } from '../src/domain/ranking';
import { recordEvent } from '../src/domain/measurement';
import { DAY_MS, HOUR_MS } from '../src/lib/time';
import { bid, db, makeProduct, makeUser } from './helpers';

const row = (id: string, o: Partial<RankInput> = {}): RankInput => ({
  productId: id, activeRankUnits: 0, ownerSuccessfulReferrals: 0, validClicks: 0, validViews: 0, achievedAt: null, publishedAt: '2026-01-01T00:00:00.000Z', ...o,
});
const order = (rows: RankInput[]) => rankProducts(rows).map(r => r.productId);

describe('ranking policy rank-v1 (pure)', () => {
  it('A22: a higher bid always wins over referrals, clicks and views', () => {
    expect(order([row('B', { activeRankUnits: 900, ownerSuccessfulReferrals: 100, validClicks: 1e6 }), row('A', { activeRankUnits: 1000 })])).toEqual(['A', 'B']);
  });
  it('A21: equal bid → more successful referrals wins even with fewer clicks', () => {
    expect(order([row('B', { activeRankUnits: 500, ownerSuccessfulReferrals: 2, validClicks: 99 }), row('A', { activeRankUnits: 500, ownerSuccessfulReferrals: 3 })])).toEqual(['A', 'B']);
  });
  it('A23: free products with equal referrals → more valid clicks wins', () => {
    expect(order([row('B', { validClicks: 4, validViews: 999 }), row('A', { validClicks: 5 })])).toEqual(['A', 'B']);
  });
  it('A24: equal bid/referrals/clicks → more valid views wins', () => {
    expect(order([row('B', { validClicks: 5, validViews: 1 }), row('A', { validClicks: 5, validViews: 2 })])).toEqual(['A', 'B']);
  });
  it('full tie with a bid → first to reach the amount wins; then published_at DESC, id ASC', () => {
    expect(order([row('B', { activeRankUnits: 100, achievedAt: '2026-01-02T00:00:00Z' }), row('A', { activeRankUnits: 100, achievedAt: '2026-01-01T00:00:00Z' })])).toEqual(['A', 'B']);
    expect(order([row('old', { publishedAt: '2026-01-01T00:00:00Z' }), row('new', { publishedAt: '2026-02-01T00:00:00Z' })])).toEqual(['new', 'old']);
    expect(order([row('b'), row('a')])).toEqual(['a', 'b']);
  });
  it('free listings always rank after paid listings', () => {
    const r = order([row('free', { ownerSuccessfulReferrals: 50, validClicks: 1e4 }), row('paid', { activeRankUnits: 1 })]);
    expect(r).toEqual(['paid', 'free']);
    expect(compareRank(row('x', { activeRankUnits: 1 }), row('y'))).toBeLessThan(0);
  });
});

describe('live standings from D1', () => {
  const T0 = Date.parse('2030-03-01T00:00:00Z');

  it('A03: A $10, B $20, A +$11 → A on top with $21', async () => {
    const u = await makeUser();
    const a = await makeProduct(u, 'Alpha A03');
    const b = await makeProduct(u, 'Beta A03');
    await bid(u, a, 'daily', 1000, T0);
    await bid(u, b, 'daily', 2000, T0 + 60_000);
    await bid(u, a, 'daily', 1100, T0 + 120_000);
    const rows = (await loadStandings(db(), 'daily', T0 + 180_000)).filter(r => [a, b].includes(r.productId));
    expect(rows.map(r => [r.productId, r.activeRankUnits])).toEqual([[a, 2100], [b, 2000]]);
  });

  it('A12 + rolling windows: each contribution expires on its own after 24h / 7d / 30d', async () => {
    const u = await makeUser();
    const p = await makeProduct(u, 'Windows');
    const t = T0 + 10 * DAY_MS;
    await bid(u, p, 'daily', 500, t);
    await bid(u, p, 'daily', 300, t + 12 * HOUR_MS);
    const amt = async (board: 'daily' | 'weekly' | 'monthly', at: number) => (await loadStandings(db(), board, at)).find(r => r.productId === p)?.activeRankUnits;
    expect(await amt('daily', t + 13 * HOUR_MS)).toBe(800);
    expect(await amt('daily', t + 25 * HOUR_MS)).toBe(300); // old one expired, new one still active
    expect(await amt('daily', t + 37 * HOUR_MS)).toBe(0);

    await bid(u, p, 'weekly', 700, t);
    expect(await amt('weekly', t + 7 * DAY_MS - 1)).toBe(700);
    expect(await amt('weekly', t + 7 * DAY_MS + 1)).toBe(0);
    await bid(u, p, 'monthly', 900, t);
    expect(await amt('monthly', t + 30 * DAY_MS - 1)).toBe(900);
    expect(await amt('monthly', t + 30 * DAY_MS + 1)).toBe(0);
    // Boards are independent: a daily bid never counts on weekly.
    expect(await amt('weekly', t + 13 * HOUR_MS)).toBe(700);
  });

  it('A23 with real measurement rows: clicks break ties between free products; duplicates per day count once', async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const a = await makeProduct(u1, 'Free Clicky');
    const b = await makeProduct(u2, 'Free Viewy');
    const at = T0 + 50 * DAY_MS;
    for (const v of ['v1', 'v2']) await recordEvent(db(), { productId: a, type: 'outbound_click', visitor: v, source: 'test', nowMs: at - HOUR_MS });
    await recordEvent(db(), { productId: a, type: 'outbound_click', visitor: 'v1', source: 'test', nowMs: at - HOUR_MS + 1 });
    for (const v of ['v1', 'v2', 'v3', 'v4']) await recordEvent(db(), { productId: b, type: 'product_page_view', visitor: v, source: 'test', nowMs: at - HOUR_MS });
    await recordEvent(db(), { productId: b, type: 'outbound_click', visitor: 'v9', source: 'test', nowMs: at - HOUR_MS });
    const rows = (await loadStandings(db(), 'daily', at)).filter(r => [a, b].includes(r.productId));
    expect(rows.map(r => r.productId)).toEqual([a, b]);
    expect(rows[0].validClicks).toBe(2);
    // Outside the 30-day window nothing counts.
    const later = (await loadStandings(db(), 'daily', at + 31 * DAY_MS)).find(r => r.productId === a);
    expect(later?.validClicks).toBe(0);
  });
});
