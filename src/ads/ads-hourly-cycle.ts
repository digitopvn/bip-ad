// The hourly ads and monitoring cycle, run by the lock/housekeeping cron within its D1 query budget:
// 1. guard: kill switch and finance reconciliation; when either fails, pause every unfinished flight;
// 2. otherwise plan the flights the lock created and execute the ones whose window is open;
// 3. record hourly metrics (as_of_at + source; no provider data means an explicit no_data row);
// 4. detect operator alert conditions and queue alert emails.
// Each step starts only when its worst case fits the remaining budget; the next hour resumes.
import type { Config } from '../domain/config';
import type { Env } from '../env';
import { detectAlerts, enqueueAlerts } from '../monitoring/operator-alerts';
import { adsBlockers, executeFlights, ingestHourlyMetrics, planDueFlights } from './ads-flight-operations';
import { pauseFlights, type Reconciler } from './ads-safety-controls';

export const ADS_CYCLE_ACTOR = 'system:ads-cycle';

/** Worst-case D1 queries per step (a batch counts as one). Planning and execution handle small pages. */
export const ADS_CYCLE_QUERIES = { guard: 4, pause: 4, plan: 2, execute: 7, metrics: 1, alerts: 5 } as const;
const PAGE = 5;

export interface Allowance {
  allows(queries: number): boolean;
}

export async function runAdsCycle(env: Env, cfg: Config, reconcile: Reconciler, nowMs: number, budget: Allowance) {
  const out: Record<string, unknown> = {};
  if (!budget.allows(ADS_CYCLE_QUERIES.guard)) return { skipped: 'budget' };
  // One reconciliation per cycle, shared by the guard and the alerts.
  const rec = await reconcile(env.DB);
  const once: Reconciler = async () => rec;
  const blockers = await adsBlockers(env, cfg, once);
  out.blockers = blockers;
  const o = { actor: ADS_CYCLE_ACTOR, nowMs, limit: PAGE };
  if (blockers.length) {
    if (budget.allows(ADS_CYCLE_QUERIES.pause)) out.paused = (await pauseFlights(env, cfg, blockers[0], o)).paused;
  } else {
    if (budget.allows(ADS_CYCLE_QUERIES.plan)) out.planned = (await planDueFlights(env, cfg, o)).planned.length;
    // Live sends add a commit batch and a status write per allocation; a dry run is one recording batch.
    if (cfg.adsMode === 'dry_run' ? budget.allows(ADS_CYCLE_QUERIES.execute) : budget.allows(ADS_CYCLE_QUERIES.execute + 3 * PAGE)) {
      out.executed = (await executeFlights(env, cfg, once, { ...o, checkedBlockers: blockers })).executed.length;
    }
  }
  if (budget.allows(ADS_CYCLE_QUERIES.metrics)) out.metrics = await ingestHourlyMetrics(env.DB, nowMs);
  if (budget.allows(ADS_CYCLE_QUERIES.alerts)) {
    const alerts = await detectAlerts(env.DB, rec, nowMs);
    await enqueueAlerts(env.DB, alerts, nowMs);
    out.alerts = alerts.map(a => a.kind);
  }
  return out;
}
