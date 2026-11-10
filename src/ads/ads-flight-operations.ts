// Ad flight lifecycle: plan (split a flight across channels), execute (dry run records the Zernio
// request; live commits against the cap, then sends), hourly metrics and the end-of-period report.
// A flight is created by the 03:12 lock for exactly one cohort of one board with hard caps
// (src/domain/snapshot.ts); nothing here can move money between flights or boards.
import { BOARD_DAYS, type Board, type Config } from '../domain/config';
import { decisionStatement, guardStatement } from '../domain/ledger';
import type { Env } from '../env';
import { newId } from '../lib/ids';
import { HOUR_MS, ictDate, iso } from '../lib/time';
import { recordRequestStatement, requestByKey, sendRecorded, zernioApiBase } from './adapter-call-log';
import { ADS_PLAN_POLICY, type ChannelPreference, planFlight } from './ads-flight-planner';
import { readKillSwitch, type Reconciler, reconcileHealthy } from './ads-safety-controls';
import { buildCreateAdRequest, parseAdsChannels, parseCreatedCampaignId } from './zernio-ads-adapter';

export const ADS_EXECUTE_POLICY = 'ads-exec-v1';

export interface OperationOptions {
  actor: string;
  nowMs?: number;
  limit?: number;
  fetcher?: typeof fetch;
}

/** Whether ads may be planned or executed right now, and why not. */
export async function adsBlockers(env: Env, cfg: Config, reconcile: Reconciler): Promise<string[]> {
  const reasons: string[] = [];
  if ((await readKillSwitch(env.DB, cfg)).engaged) reasons.push('KILL_SWITCH_ENGAGED');
  if (!reconcileHealthy(await reconcile(env.DB))) reasons.push('RECONCILE_UNBALANCED');
  return reasons;
}

interface PlannableFlight {
  id: string;
  board: Board;
  currency: string;
  spend_cap_minor: number;
  daily_cap_minor: number;
}

/**
 * Plan flights the lock created (state planned), and re-try held ones once channels are configured.
 * Idempotent: a scheduled flight is never re-planned, and a held flight that still cannot be funded is left untouched.
 */
export async function planDueFlights(env: Env, cfg: Config, o: OperationOptions & { prefer?: ChannelPreference }) {
  const db = env.DB;
  const nowMs = o.nowMs ?? Date.now();
  const now = iso(nowMs);
  const { channels, error } = parseAdsChannels(env.ZERNIO_ADS_ACCOUNTS);
  // The join pins each flight to its own cohort: same board, same currency, cap within that cohort's 80% fund.
  const { results } = await db.prepare(`SELECT f.id, f.board, f.currency, f.spend_cap_minor, f.daily_cap_minor FROM ad_flights f
      JOIN revenue_cohorts c ON c.id = f.cohort_id AND c.board = f.board AND c.currency = f.currency AND f.spend_cap_minor <= c.ads_fund_minor
      WHERE f.state IN ('planned', ${channels.length ? `'held'` : `'planned'`}) AND f.end_at > ? ORDER BY f.start_at, f.id LIMIT ?`).bind(now, o.limit ?? 20).all<PlannableFlight & { state: string }>();
  const statements: D1PreparedStatement[] = [];
  const planned = results.flatMap(f => {
    const plan = planFlight({ currency: f.currency, spendCapMinor: f.spend_cap_minor, dailyCapMinor: f.daily_cap_minor, days: BOARD_DAYS[f.board] }, channels, o.prefer);
    if (f.state === 'held' && !plan.allocations.length) return [];
    const reasons = error ? ['CHANNEL_CONFIG_INVALID', ...plan.reasons] : plan.reasons;
    const allocated = plan.allocations.reduce((a, x) => a + x.amountMinor, 0);
    statements.push(
      ...plan.allocations.map(a => db.prepare(`INSERT INTO ad_flight_allocations (id, flight_id, channel, daily_minor, amount_minor, state, policy_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?) ON CONFLICT (flight_id, channel) DO NOTHING`).bind(newId('alc'), f.id, a.channel, a.dailyMinor, a.amountMinor, ADS_PLAN_POLICY, now, now)),
      db.prepare(`UPDATE ad_flights SET planned_minor = ?, unallocated_minor = ?, state = ? WHERE id = ? AND state IN ('planned', 'held')`)
        .bind(allocated, plan.unallocatedMinor, plan.allocations.length ? 'scheduled' : 'held', f.id),
      decisionStatement(db, { actor: o.actor, action: 'ads.plan', decision: plan.allocations.length ? 'allow' : 'defer', reasons: reasons.length ? reasons : ['WITHIN_CAPS'],
        policy: ADS_PLAN_POLICY, resourceId: f.id, result: { board: f.board, currency: f.currency, spend_cap_minor: f.spend_cap_minor, daily_cap_minor: f.daily_cap_minor, allocations: plan.allocations, unallocated_minor: plan.unallocatedMinor } }, now),
    );
    return [{ flight_id: f.id, board: f.board, allocations: plan.allocations, unallocated_minor: plan.unallocatedMinor, reasons }];
  });
  if (statements.length) await db.batch(statements);
  return { planned, channel_config_error: error };
}

interface ExecutableAllocation {
  id: string;
  flight_id: string;
  channel: string;
  daily_minor: number;
  amount_minor: number;
  board: Board;
  currency: string;
  start_at: string;
  end_at: string;
  cutoff_at: string;
}

/** Effect of an accepted create-ad request on its allocation. */
export function allocationSentStatements(db: D1Database, allocationId: string, response: unknown, now: string): D1PreparedStatement[] {
  return [db.prepare(`UPDATE ad_flight_allocations SET state = 'sent', external_campaign_id = ?, updated_at = ? WHERE id = ?`).bind(parseCreatedCampaignId(response), now, allocationId)];
}

/**
 * Execute scheduled allocations whose flight window is open. Dry run: the exact request is
 * recorded and nothing is sent, committed or spent. Live: the allocation is committed against the
 * flight cap atomically first (a lost race aborts the batch), then sent once with its idempotency key.
 */
export async function executeFlights(env: Env, cfg: Config, reconcile: Reconciler, o: OperationOptions & { flightId?: string; checkedBlockers?: string[] }) {
  const db = env.DB;
  const nowMs = o.nowMs ?? Date.now();
  const now = iso(nowMs);
  const blockers = o.checkedBlockers ?? await adsBlockers(env, cfg, reconcile);
  if (blockers.length) {
    await decisionStatement(db, { actor: o.actor, action: 'ads.execute', decision: 'deny', reasons: blockers, policy: ADS_EXECUTE_POLICY, resourceId: o.flightId, result: { mode: cfg.adsMode } }, now).run();
    return { mode: cfg.adsMode, blocked: blockers, executed: [] };
  }
  const { channels } = parseAdsChannels(env.ZERNIO_ADS_ACCOUNTS);
  const { results } = await db.prepare(`SELECT a.id, a.flight_id, a.channel, a.daily_minor, a.amount_minor, f.board, f.currency, f.start_at, f.end_at, c.cutoff_at
      FROM ad_flight_allocations a JOIN ad_flights f ON f.id = a.flight_id JOIN revenue_cohorts c ON c.id = f.cohort_id
      WHERE a.state = 'planned' AND f.state IN ('scheduled', 'active') AND f.start_at <= ? AND f.end_at > ? ${o.flightId ? 'AND f.id = ?' : ''}
      ORDER BY f.start_at, a.channel LIMIT ?`).bind(now, now, ...(o.flightId ? [o.flightId] : []), o.limit ?? 20).all<ExecutableAllocation>();
  const apiBase = zernioApiBase(env.ZERNIO_API_BASE);
  const mode = cfg.adsMode;
  const dryRun: D1PreparedStatement[] = [];
  const executed: Record<string, unknown>[] = [];
  for (const a of results) {
    const channel = channels.find(c => c.channel === a.channel);
    if (!channel) {
      await decisionStatement(db, { actor: o.actor, action: 'ads.execute', decision: 'deny', reasons: ['CHANNEL_NOT_CONFIGURED'], policy: ADS_EXECUTE_POLICY, resourceId: a.flight_id, result: { channel: a.channel } }, now).run();
      executed.push({ allocation_id: a.id, flight_id: a.flight_id, channel: a.channel, status: 'skipped', reason: 'CHANNEL_NOT_CONFIGURED' });
      continue;
    }
    const date = ictDate(Date.parse(a.cutoff_at));
    const request = buildCreateAdRequest({
      apiBase, allocationId: a.id, channel, board: a.board, date, currency: a.currency, dailyMinor: a.daily_minor,
      startAt: a.start_at < now ? now : a.start_at, endAt: a.end_at, snapshotUrl: `${cfg.origin}/s/${a.board}/${date}`, imageUrl: `${cfg.origin}/img/bip-ad-logo.png`,
    });
    const call = { adapter: 'ads' as const, operation: 'ads.create', mode, resourceId: a.id, request };
    const decision = (decision: 'allow' | 'defer', reason: string) => decisionStatement(db, { actor: o.actor, action: 'ads.execute', decision, reasons: [reason], policy: ADS_EXECUTE_POLICY,
      resourceId: a.flight_id, result: { allocation_id: a.id, channel: a.channel, amount_minor: a.amount_minor, daily_minor: a.daily_minor, idempotency_key: request.idempotencyKey } }, now);
    if (mode === 'dry_run') {
      dryRun.push(
        recordRequestStatement(db, call, nowMs),
        db.prepare(`UPDATE ad_flight_allocations SET state = 'recorded', updated_at = ? WHERE id = ? AND state = 'planned'`).bind(now, a.id),
        db.prepare(`UPDATE ad_flights SET state = 'active', adapter_status = 'dry_run' WHERE id = ? AND state IN ('scheduled', 'active')`).bind(a.flight_id),
        decision('defer', 'ADS_DRY_RUN'),
      );
      executed.push({ allocation_id: a.id, flight_id: a.flight_id, channel: a.channel, status: 'recorded', request: { method: request.method, url: request.url, body: request.body } });
      continue;
    }
    // Live: reserve the allocation against the cap in one batch; changes() = 1 proves this run made the transition.
    await db.batch([
      db.prepare(`UPDATE ad_flight_allocations SET state = 'committed', updated_at = ? WHERE id = ? AND state = 'planned'`).bind(now, a.id),
      guardStatement(db, 'changes() = 1'),
      db.prepare(`UPDATE ad_flights SET committed_minor = committed_minor + ?, state = 'active', adapter_status = 'live' WHERE id = ? AND committed_minor + ? <= spend_cap_minor`)
        .bind(a.amount_minor, a.flight_id, a.amount_minor),
      guardStatement(db, 'changes() = 1'),
      recordRequestStatement(db, call, nowMs),
      decision('allow', 'COMMITTED_WITHIN_CAP'),
    ]);
    const row = await requestByKey(db, request.idempotencyKey);
    if (!row) throw new Error(`ads request ${request.idempotencyKey} was not stored`);
    const outcome = await sendRecorded(db, row, { apiKey: env.ZERNIO_API_KEY, fetcher: o.fetcher }, nowMs,
      response => allocationSentStatements(db, a.id, response, now),
      () => [db.prepare(`UPDATE ad_flight_allocations SET state = 'failed', updated_at = ? WHERE id = ? AND state = 'committed'`).bind(now, a.id)]);
    executed.push({ allocation_id: a.id, flight_id: a.flight_id, channel: a.channel, status: outcome.ok ? 'sent' : 'failed', ...(outcome.ok ? {} : { error: outcome.error }) });
  }
  if (dryRun.length) await db.batch(dryRun);
  return { mode, blocked: [], executed, note: mode === 'dry_run' ? 'Dry run: requests are recorded exactly as they would be sent; nothing was sent, committed or spent.' : undefined };
}

/** Metric source labels: there is no provider data in a dry run, and provider ingestion is not built yet. */
export const METRIC_SOURCE = { dry_run: 'dry_run_no_provider', live: 'zernio_not_ingested' } as const;

/**
 * Hourly metrics: one row per running flight and hour with as_of_at and source. No provider
 * numbers are available yet, so every row is an explicit no_data state; nothing is estimated.
 */
export async function ingestHourlyMetrics(db: D1Database, nowMs = Date.now()) {
  const now = iso(nowMs);
  const hour = iso(Math.floor(nowMs / HOUR_MS) * HOUR_MS);
  const r = await db.prepare(`INSERT INTO ad_metrics (id, flight_id, hour, as_of_at, source, state, created_at)
      SELECT 'met_' || lower(hex(randomblob(10))), id, ?1, ?2, CASE adapter_status WHEN 'live' THEN ?3 ELSE ?4 END, 'no_data', ?2
      FROM ad_flights WHERE state IN ('active', 'paused') AND start_at <= ?2 AND end_at > ?1
      ON CONFLICT (flight_id, hour) DO NOTHING`).bind(hour, now, METRIC_SOURCE.live, METRIC_SOURCE.dry_run).run();
  return { hour, rows: r.meta.changes ?? 0 };
}

/** End-of-period report: what each ended flight had, committed, spent and left, and why money is unspent. */
export async function adsReport(db: D1Database, o: { board?: Board; endedBefore?: string; nowMs?: number }) {
  const until = o.endedBefore ?? iso(o.nowMs ?? Date.now());
  const { results } = await db.prepare(`SELECT f.id, f.board, f.currency, c.cutoff_at, f.start_at, f.end_at, f.spend_cap_minor, f.daily_cap_minor, f.planned_minor, f.committed_minor,
        f.spent_minor, f.unallocated_minor, f.state, f.adapter_status, f.paused_reason,
        (SELECT as_of_at FROM ad_metrics m WHERE m.flight_id = f.id ORDER BY hour DESC LIMIT 1) AS metrics_as_of_at,
        (SELECT source FROM ad_metrics m WHERE m.flight_id = f.id ORDER BY hour DESC LIMIT 1) AS metrics_source
      FROM ad_flights f JOIN revenue_cohorts c ON c.id = f.cohort_id WHERE f.end_at <= ? ${o.board ? 'AND f.board = ?' : ''} ORDER BY f.end_at DESC LIMIT 200`)
    .bind(until, ...(o.board ? [o.board] : [])).all<Record<string, unknown> & { id: string; board: string; currency: string; spend_cap_minor: number; spent_minor: number; committed_minor: number;
      unallocated_minor: number; adapter_status: string; state: string; paused_reason: string | null }>();
  const totals = new Map<string, { board: string; currency: string; funded_minor: number; spent_minor: number; unspent_minor: number; flights: number }>();
  const flights = results.map(f => {
    const reasons: string[] = [];
    if (f.adapter_status !== 'live') reasons.push('DRY_RUN_NOTHING_SENT');
    if (f.paused_reason) reasons.push(`PAUSED_${f.paused_reason}`);
    if (f.unallocated_minor > 0) reasons.push('UNALLOCATED_BELOW_CHANNEL_MINIMUM_OR_NO_CHANNEL');
    if (f.state === 'planned') reasons.push('NEVER_PLANNED');
    const unspent = f.spend_cap_minor - f.spent_minor;
    const key = `${f.board}:${f.currency}`;
    const t = totals.get(key) ?? { board: f.board, currency: f.currency, funded_minor: 0, spent_minor: 0, unspent_minor: 0, flights: 0 };
    t.funded_minor += f.spend_cap_minor; t.spent_minor += f.spent_minor; t.unspent_minor += unspent; t.flights++;
    totals.set(key, t);
    return { ...f, unspent_minor: unspent, unspent_reasons: unspent > 0 ? reasons : [] };
  });
  return {
    ended_before: until, totals: [...totals.values()], flights,
    policy: 'Unspent ads funds stay with their board and cohort; they are never moved to another board or booked as operator revenue.',
  };
}
