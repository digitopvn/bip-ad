import { describe, expect, it } from 'vitest';
import { planFlight } from '../src/ads/ads-flight-planner';
import { adsReport, executeFlights, ingestHourlyMetrics, planDueFlights } from '../src/ads/ads-flight-operations';
import { ADS_CYCLE_QUERIES, runAdsCycle } from '../src/ads/ads-hourly-cycle';
import { readKillSwitch, resumeFlights, setKillSwitch } from '../src/ads/ads-safety-controls';
import { parseAdsChannels, type AdsChannel } from '../src/ads/zernio-ads-adapter';
import { config } from '../src/domain/config';
import { meteredDb, QueryBudget } from '../src/email/d1-query-meter';
import { DAY_MS, HOUR_MS } from '../src/lib/time';
import { CHANNELS, cfgOf, envWith, fakeFetch, flightRow, healthy, noFetch, operatorTool, unbalanced, weeklyFlight } from './ads-helpers';
import { db, E } from './helpers';

const actor = 'operator:test';
const dryEnv = () => envWith({ ZERNIO_ADS_ACCOUNTS: CHANNELS });

describe('ads configuration', () => {
  it('ADS_MODE=live is refused without the explicit ADS_LIVE_APPROVED flag; typos fail closed', () => {
    expect(config(envWith({ ADS_MODE: undefined })).adsMode).toBe('dry_run');
    expect(config(envWith({ ADS_MODE: 'live' })).adsMode).toBe('dry_run');
    expect(config(envWith({ ADS_MODE: 'live', ADS_LIVE_APPROVED: 'yes' })).adsMode).toBe('dry_run');
    expect(config(envWith({ ADS_MODE: 'live', ADS_LIVE_APPROVED: 'true' })).adsMode).toBe('live');
    expect(() => config(envWith({ ADS_MODE: 'Live' }))).toThrow(/ADS_MODE/);
    expect(config(envWith({ SOCIAL_MODE: undefined })).socialMode).toBe('mock');
    expect(() => config(envWith({ SOCIAL_MODE: 'on' }))).toThrow(/SOCIAL_MODE/);
  });

  it('rejects malformed channel configuration instead of guessing', () => {
    expect(parseAdsChannels(undefined)).toEqual({ channels: [], error: null });
    expect(parseAdsChannels('not json').error).toMatch(/JSON/);
    expect(parseAdsChannels('[{"channel":"meta"}]').error).toMatch(/invalid/);
    expect(parseAdsChannels(CHANNELS).channels.map(c => c.channel)).toEqual(['meta', 'tiktok']);
  });
});

describe('ads planner', () => {
  it('never exceeds the spend cap or the daily cap, in whole currency units, for any budget', () => {
    const pool: AdsChannel[] = [
      { channel: 'a', accountId: 'x', adAccountId: 'y', minDailyMinor: 100 },
      { channel: 'b', accountId: 'x', adAccountId: 'y', minDailyMinor: 700 },
      { channel: 'c', accountId: 'x', adAccountId: 'y' },
    ];
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
    for (let i = 0; i < 500; i++) {
      const currency = i % 3 === 0 ? 'VND' : 'USD';
      const days = [1, 7, 30][i % 3];
      const spendCapMinor = rnd(currency === 'VND' ? 50_000_000 : 500_000);
      const dailyCapMinor = Math.floor(spendCapMinor / days) - rnd(3);
      const channels = pool.slice(0, rnd(4));
      const plan = planFlight({ currency, spendCapMinor, dailyCapMinor, days }, channels);
      const unit = currency === 'VND' ? 1 : 100;
      const total = plan.allocations.reduce((a, x) => a + x.amountMinor, 0);
      const daily = plan.allocations.reduce((a, x) => a + x.dailyMinor, 0);
      expect(total).toBeLessThanOrEqual(spendCapMinor);
      expect(daily).toBeLessThanOrEqual(Math.max(0, dailyCapMinor));
      expect(total + plan.unallocatedMinor).toBe(spendCapMinor);
      for (const a of plan.allocations) {
        expect(a.amountMinor).toBe(a.dailyMinor * days);
        expect(a.dailyMinor % unit).toBe(0);
        const ch = channels.find(c => c.channel === a.channel)!;
        expect(a.dailyMinor).toBeGreaterThanOrEqual(ch.minDailyMinor ?? unit);
      }
    }
  });

  it('holds the fund when no channel can be funded at its minimum, and an optional hook cannot add channels', () => {
    const ch: AdsChannel[] = [{ channel: 'meta', accountId: 'x', adAccountId: 'y', minDailyMinor: 5000 }];
    expect(planFlight({ currency: 'USD', spendCapMinor: 700, dailyCapMinor: 100, days: 7 }, ch)).toEqual({ allocations: [], unallocatedMinor: 700, reasons: ['BELOW_CHANNEL_MINIMUM'] });
    expect(planFlight({ currency: 'USD', spendCapMinor: 700, dailyCapMinor: 100, days: 7 }, []).reasons).toEqual(['NO_CHANNELS_CONFIGURED']);
    const sneaky = () => [{ channel: 'other', accountId: 'x', adAccountId: 'y' }];
    expect(planFlight({ currency: 'USD', spendCapMinor: 70_000, dailyCapMinor: 10_000, days: 7 }, ch, sneaky).allocations).toEqual([]);
  });

  it('plans each lock-created flight within its own cohort fund and records the decision', async () => {
    const { flight } = await weeklyFlight('2033-02-01');
    expect(flight).toMatchObject({ state: 'planned', spend_cap_minor: 5600, daily_cap_minor: 800 });
    const env = dryEnv();
    const r = await planDueFlights(env, cfgOf(env), { actor, nowMs: Date.parse('2033-01-31T21:00:00Z') });
    const mine = r.planned.find(p => p.flight_id === flight.id)!;
    // $8/day cannot fund tiktok's $5 minimum alongside meta, so meta takes all of it.
    expect(mine.allocations).toEqual([{ channel: 'meta', dailyMinor: 800, amountMinor: 5600 }]);
    expect(mine.reasons).toEqual(['SOME_CHANNELS_BELOW_MINIMUM']);
    expect(await flightRow(flight.id)).toMatchObject({ state: 'scheduled', planned_minor: 5600, unallocated_minor: 0 });
    const again = await planDueFlights(env, cfgOf(env), { actor, nowMs: Date.parse('2033-01-31T22:00:00Z') });
    expect(again.planned.find(p => p.flight_id === flight.id)).toBeUndefined(); // idempotent
    const dec = await db().prepare(`SELECT decision FROM decision_logs WHERE action = 'ads.plan' AND resource_id = ?`).bind(flight.id).all();
    expect(dec.results).toEqual([{ decision: 'allow' }]);
  });
});

describe('held flights', () => {
  it('a flight without any channel is held with its whole fund and planned once a channel is configured', async () => {
    const { C, flight } = await weeklyFlight('2033-02-10');
    const bare = envWith({ ZERNIO_ADS_ACCOUNTS: undefined });
    await planDueFlights(bare, cfgOf(bare), { actor, nowMs: C + HOUR_MS });
    expect(await flightRow(flight.id)).toMatchObject({ state: 'held', planned_minor: 0, unallocated_minor: 5600 });
    // Still no channel: nothing is rewritten or logged again.
    expect((await planDueFlights(bare, cfgOf(bare), { actor, nowMs: C + 2 * HOUR_MS })).planned.find(p => p.flight_id === flight.id)).toBeUndefined();
    const env = dryEnv();
    await planDueFlights(env, cfgOf(env), { actor, nowMs: C + 3 * HOUR_MS });
    expect(await flightRow(flight.id)).toMatchObject({ state: 'scheduled', planned_minor: 5600, unallocated_minor: 0 });
    const dec = await db().prepare(`SELECT decision FROM decision_logs WHERE action = 'ads.plan' AND resource_id = ? ORDER BY created_at`).bind(flight.id).all();
    expect(dec.results).toEqual([{ decision: 'defer' }, { decision: 'allow' }]);
  });
});

describe('ads execution', () => {
  it('a dry run records exactly the Zernio request it would send and spends nothing', async () => {
    const { C, flight } = await weeklyFlight('2033-03-01');
    const env = dryEnv();
    const cfg = cfgOf(env);
    expect(cfg.adsMode).toBe('dry_run');
    await planDueFlights(env, cfg, { actor, nowMs: C + HOUR_MS });
    const r = await executeFlights(env, cfg, healthy, { actor, nowMs: C + HOUR_MS, flightId: flight.id, fetcher: noFetch });
    expect(r.executed).toHaveLength(1);
    expect(r.executed[0]).toMatchObject({ status: 'recorded', channel: 'meta' });
    const req = await db().prepare(`SELECT * FROM adapter_requests a JOIN ad_flight_allocations l ON l.id = a.resource_id WHERE l.flight_id = ?`).bind(flight.id).first<{ mode: string; status: string; method: string; url: string; body_json: string }>();
    expect(req).toMatchObject({ mode: 'dry_run', status: 'recorded', method: 'POST', url: 'https://zernio.com/api/v1/ads/create' });
    const body = JSON.parse(req!.body_json);
    expect(body).toMatchObject({ accountId: 'acc_meta', adAccountId: 'act_123', budgetAmount: 8, budgetType: 'daily', goal: 'traffic', endDate: new Date(C + 7 * DAY_MS).toISOString(), linkUrl: `${cfg.origin}/s/weekly/2033-03-01`, imageUrl: `${cfg.origin}/img/bip-ad-logo.png`, status: 'ACTIVE' });
    const f = await flightRow(flight.id);
    expect(f).toMatchObject({ state: 'active', adapter_status: 'dry_run', committed_minor: 0, spent_minor: 0 });
    // Running again records nothing new.
    expect((await executeFlights(env, cfg, healthy, { actor, nowMs: C + 2 * HOUR_MS, flightId: flight.id, fetcher: noFetch })).executed).toEqual([]);
  });

  it('live mode commits against the cap before sending, once, even when run twice', async () => {
    const { C, flight } = await weeklyFlight('2033-03-05');
    const env = envWith({ ZERNIO_ADS_ACCOUNTS: CHANNELS, ADS_MODE: 'live', ADS_LIVE_APPROVED: 'true', ZERNIO_API_KEY: 'sk_test_ads' });
    const cfg = cfgOf(env);
    await planDueFlights(env, cfg, { actor, nowMs: C + HOUR_MS });
    const { fetcher, calls } = fakeFetch({ status: 201, body: { campaignId: 'cmp_1' } });
    const r = await executeFlights(env, cfg, healthy, { actor, nowMs: C + HOUR_MS, flightId: flight.id, fetcher });
    expect(r.executed[0]).toMatchObject({ status: 'sent' });
    expect(calls).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk_test_ads');
    await executeFlights(env, cfg, healthy, { actor, nowMs: C + 2 * HOUR_MS, flightId: flight.id, fetcher });
    expect(calls).toHaveLength(1);
    expect(await flightRow(flight.id)).toMatchObject({ committed_minor: 5600, spent_minor: 0, adapter_status: 'live' });
    const stored = await db().prepare(`SELECT COUNT(*) AS n FROM adapter_requests WHERE body_json LIKE '%sk_test%' OR response_json LIKE '%sk_test%'`).first<{ n: number }>();
    expect(stored!.n).toBe(0);
  });

  it('refuses cross-board execution through the operator tool', async () => {
    const { flight } = await weeklyFlight('2033-03-09');
    const r = await operatorTool('ads.execute', { flight_id: flight.id, board: 'daily' });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('cross_board_spend');
    const dec = await db().prepare(`SELECT reason_codes_json FROM decision_logs WHERE action = 'ads.execute' AND resource_id = ?`).bind(flight.id).first<{ reason_codes_json: string }>();
    expect(JSON.parse(dec!.reason_codes_json)).toEqual(['CROSS_BOARD_SPEND']);
  });
});

describe('ads safety', () => {
  it('pauses every unfinished flight when finance.reconcile is unbalanced, and refuses to resume until it balances', async () => {
    const { C, flight } = await weeklyFlight('2033-04-01');
    const env = dryEnv();
    const cfg = cfgOf(env);
    const out = await runAdsCycle(env, cfg, unbalanced, C + HOUR_MS, new QueryBudget(100));
    expect(out.blockers).toEqual(['RECONCILE_UNBALANCED']);
    expect(out.paused).toContain(flight.id);
    expect(await flightRow(flight.id)).toMatchObject({ state: 'paused', paused_reason: 'RECONCILE_UNBALANCED', paused_from_state: 'planned' });
    const blocked = await executeFlights(env, cfg, unbalanced, { actor, nowMs: C + HOUR_MS, flightId: flight.id, fetcher: noFetch });
    expect(blocked.blocked).toEqual(['RECONCILE_UNBALANCED']);
    await expect(resumeFlights(env, cfg, unbalanced, 'try', { actor, flightIds: [flight.id], nowMs: C + HOUR_MS })).rejects.toMatchObject({ code: 'reconcile_unbalanced' });
    const pauses = await db().prepare(`SELECT COUNT(*) AS n FROM decision_logs WHERE action = 'ads.pause' AND result_json LIKE ?`).bind(`%${flight.id}%`).first<{ n: number }>();
    expect(pauses!.n).toBe(1);
    // Balanced again: the operator resumes it where it stopped, and the next cycle plans it.
    expect((await resumeFlights(env, cfg, healthy, 'ledger fixed', { actor, flightIds: [flight.id], nowMs: C + 2 * HOUR_MS })).resumed).toEqual([flight.id]);
    expect((await flightRow(flight.id)).state).toBe('planned');
    await runAdsCycle(env, cfg, healthy, C + 3 * HOUR_MS, new QueryBudget(100));
    expect((await flightRow(flight.id)).state).toBe('active');
  });

  it('the kill switch pauses flights, blocks execution, and keeps them paused after release until ads.resume', async () => {
    const { C, flight } = await weeklyFlight('2033-04-05');
    const env = dryEnv();
    const cfg = cfgOf(env);
    const on = await setKillSwitch(env, cfg, true, 'suspicious traffic', { actor, nowMs: C + HOUR_MS });
    expect(on.kill_switch).toMatchObject({ engaged: true, source: 'operator' });
    expect(on.paused_flights).toContain(flight.id);
    expect((await executeFlights(env, cfg, healthy, { actor, nowMs: C + HOUR_MS, fetcher: noFetch })).blocked).toEqual(['KILL_SWITCH_ENGAGED']);
    await expect(resumeFlights(env, cfg, healthy, 'try', { actor, flightIds: [flight.id] })).rejects.toMatchObject({ code: 'kill_switch_engaged' });
    const off = await setKillSwitch(env, cfg, false, 'cleared', { actor, nowMs: C + 2 * HOUR_MS });
    expect(off.kill_switch.engaged).toBe(false);
    expect((await flightRow(flight.id)).state).toBe('paused');
    expect((await resumeFlights(env, cfg, healthy, 'cleared', { actor, flightIds: [flight.id], nowMs: C + 2 * HOUR_MS })).resumed).toEqual([flight.id]);
    // The configuration switch wins over a release.
    const forced = envWith({ ZERNIO_ADS_ACCOUNTS: CHANNELS, ADS_KILL_SWITCH: 'true' });
    expect(await readKillSwitch(db(), cfgOf(forced))).toMatchObject({ engaged: true, source: 'config' });
    const tool = await operatorTool('ads.kill_switch', { engaged: false, reason: 'try release' }, forced);
    expect(tool.data.kill_switch.engaged).toBe(true);
  });
});

describe('ads metrics and report', () => {
  it('records hourly no-data rows with as_of_at and source, never numbers, and reports unspent money with reasons', async () => {
    const { C, flight } = await weeklyFlight('2033-05-01');
    const env = dryEnv();
    const cfg = cfgOf(env);
    await runAdsCycle(env, cfg, healthy, C + HOUR_MS, new QueryBudget(100));
    await ingestHourlyMetrics(db(), C + HOUR_MS + 60_000); // same hour: no duplicate
    const m = await db().prepare('SELECT * FROM ad_metrics WHERE flight_id = ?').bind(flight.id).all<Record<string, unknown>>();
    expect(m.results).toHaveLength(1);
    expect(m.results[0]).toMatchObject({ state: 'no_data', source: 'dry_run_no_provider', spend_minor: null, impressions: null, clicks: null, as_of_at: new Date(C + HOUR_MS).toISOString() });
    const report = await adsReport(db(), { board: 'weekly', endedBefore: new Date(C + 8 * DAY_MS).toISOString() });
    const row = report.flights.find(f => f.id === flight.id)!;
    expect(row).toMatchObject({ spend_cap_minor: 5600, spent_minor: 0, unspent_minor: 5600, metrics_source: 'dry_run_no_provider' });
    expect(row.unspent_reasons).toContain('DRY_RUN_NOTHING_SENT');
    expect(report.policy).toMatch(/never moved to another board/);
  });

  it('the hourly cycle stays within its declared query budget', async () => {
    const { C } = await weeklyFlight('2033-05-10');
    const env = dryEnv();
    const budget = new QueryBudget(1000);
    await runAdsCycle({ ...env, DB: meteredDb(E.DB, budget) }, cfgOf(env), healthy, C + HOUR_MS, budget);
    const declared = Object.values(ADS_CYCLE_QUERIES).reduce((a, b) => a + b, 0) - ADS_CYCLE_QUERIES.pause;
    // The guard's reconcile is a stub here, so the real run is cheaper than the declared worst case.
    expect(budget.used).toBeLessThanOrEqual(declared);
    const tight = new QueryBudget(3);
    expect(await runAdsCycle({ ...env, DB: meteredDb(E.DB, tight) }, cfgOf(env), healthy, C + HOUR_MS, tight)).toEqual({ skipped: 'budget' });
  });
});
