// Ads safety controls: the kill switch (ADS_KILL_SWITCH config or the operator switch), the
// reconciliation guard, and pause/resume of flights. Pausing never needs permission; resuming
// needs the kill switch off and a balanced ledger. Every pause and resume is in the decision log.
import { type Config } from '../domain/config';
import { DomainError } from '../domain/errors';
import { decisionStatement } from '../domain/ledger';
import type { Env } from '../env';
import { newId } from '../lib/ids';
import { iso } from '../lib/time';
import { recordRequest, sendRecorded, zernioApiBase } from './adapter-call-log';
import { buildCampaignStatusRequest } from './zernio-ads-adapter';

export const ADS_SAFETY_POLICY = 'ads-safety-v1';
const KILL_SWITCH_KEY = 'ads_kill_switch';
/** Flight states that can be paused (anything not finished). */
const PAUSABLE = `('planned', 'held', 'scheduled', 'active')`;

/** The subset of finance.reconcile the guard reads. */
export interface ReconcileResult {
  balanced: boolean;
  unbalanced?: unknown[];
  wallet_drift: unknown[];
}
export type Reconciler = (db: D1Database) => Promise<ReconcileResult>;

/** Reconciliation passes only when every transaction balances and no wallet projection drifts. */
export const reconcileHealthy = (r: ReconcileResult) => r.balanced && r.wallet_drift.length === 0;

export interface KillSwitchState {
  engaged: boolean;
  source: 'config' | 'operator' | null;
  reason: string | null;
  changed_at: string | null;
  changed_by: string | null;
}

export async function readKillSwitch(db: D1Database, cfg: Config): Promise<KillSwitchState> {
  const row = await db.prepare('SELECT value FROM operator_settings WHERE key = ?').bind(KILL_SWITCH_KEY).first<{ value: string }>();
  const op = row ? (JSON.parse(row.value) as { engaged: boolean; reason: string; at: string; actor: string }) : null;
  if (cfg.adsKillSwitch) return { engaged: true, source: 'config', reason: 'ADS_KILL_SWITCH=true', changed_at: op?.at ?? null, changed_by: op?.actor ?? null };
  if (op?.engaged) return { engaged: true, source: 'operator', reason: op.reason, changed_at: op.at, changed_by: op.actor };
  return { engaged: false, source: null, reason: op?.reason ?? null, changed_at: op?.at ?? null, changed_by: op?.actor ?? null };
}

export interface ControlOptions {
  actor: string;
  nowMs?: number;
  fetcher?: typeof fetch;
}

/** Engage or release the operator kill switch. Engaging pauses every unfinished flight at once. */
export async function setKillSwitch(env: Env, cfg: Config, engaged: boolean, reason: string, o: ControlOptions) {
  const nowMs = o.nowMs ?? Date.now();
  const now = iso(nowMs);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO operator_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(KILL_SWITCH_KEY, JSON.stringify({ engaged, reason, at: now, actor: o.actor }), now),
    decisionStatement(env.DB, { actor: o.actor, action: 'ads.kill_switch', decision: engaged ? 'deny' : 'allow', reasons: [engaged ? 'KILL_SWITCH_ENGAGED' : 'KILL_SWITCH_RELEASED'], policy: ADS_SAFETY_POLICY, result: { reason } }, now),
  ]);
  const paused = engaged ? await pauseFlights(env, cfg, 'KILL_SWITCH', o) : { paused: [] as string[] };
  const state = await readKillSwitch(env.DB, cfg);
  return { kill_switch: state, paused_flights: paused.paused, note: !engaged && state.engaged ? 'ADS_KILL_SWITCH=true in the configuration keeps ads stopped.' : !engaged ? 'Released. Paused flights stay paused until ads.resume.' : undefined };
}

/**
 * Pause unfinished flights (all, or the given ids). Idempotent: already paused flights are left as
 * they are, so the hourly guard logs a pause only when it actually paused something. Live campaigns
 * are paused at the provider too; a failed provider call is dead-lettered and alerted.
 */
export async function pauseFlights(env: Env, cfg: Config, reason: string, o: ControlOptions & { flightIds?: string[] }) {
  const db = env.DB;
  const nowMs = o.nowMs ?? Date.now();
  const now = iso(nowMs);
  const ids = o.flightIds ?? null;
  if (ids && !ids.length) return { paused: [] as string[] };
  const { results } = await db.prepare(`UPDATE ad_flights SET paused_from_state = state, state = 'paused', paused_reason = ?, paused_at = ?
      WHERE state IN ${PAUSABLE} AND end_at > ? ${ids ? `AND id IN (${ids.map(() => '?').join(', ')})` : ''} RETURNING id`)
    .bind(reason, now, now, ...(ids ?? [])).all<{ id: string }>();
  const paused = results.map(r => r.id);
  if (!paused.length) return { paused };
  await decisionStatement(db, { actor: o.actor, action: 'ads.pause', decision: 'deny', reasons: [reason], policy: ADS_SAFETY_POLICY, result: { flights: paused, mode: cfg.adsMode } }, now).run();
  await setProviderStatus(env, cfg, paused, 'paused', o, nowMs);
  return { paused };
}

/** Resume paused flights where they stopped. Refused while the kill switch is on or the ledger does not reconcile. */
export async function resumeFlights(env: Env, cfg: Config, reconcile: Reconciler, note: string, o: ControlOptions & { flightIds?: string[] }) {
  const db = env.DB;
  const nowMs = o.nowMs ?? Date.now();
  const now = iso(nowMs);
  const deny = async (code: string, message: string) => {
    await decisionStatement(db, { actor: o.actor, action: 'ads.resume', decision: 'deny', reasons: [code], policy: ADS_SAFETY_POLICY, result: { note } }, now).run();
    throw new DomainError(code.toLowerCase(), message, 409);
  };
  if ((await readKillSwitch(db, cfg)).engaged) await deny('KILL_SWITCH_ENGAGED', 'The ads kill switch is on; release it first');
  if (!reconcileHealthy(await reconcile(db))) await deny('RECONCILE_UNBALANCED', 'finance.reconcile is unbalanced; ads stay paused');
  const ids = o.flightIds ?? null;
  if (ids && !ids.length) return { resumed: [] as string[] };
  const { results } = await db.prepare(`UPDATE ad_flights SET state = COALESCE(paused_from_state, 'planned'), paused_reason = NULL, paused_at = NULL, paused_from_state = NULL
      WHERE state = 'paused' AND end_at > ? ${ids ? `AND id IN (${ids.map(() => '?').join(', ')})` : ''} RETURNING id`).bind(now, ...(ids ?? [])).all<{ id: string }>();
  const resumed = results.map(r => r.id);
  if (resumed.length) {
    await decisionStatement(db, { actor: o.actor, action: 'ads.resume', decision: 'allow', reasons: ['RESUMED'], policy: ADS_SAFETY_POLICY, result: { flights: resumed, note } }, now).run();
    await setProviderStatus(env, cfg, resumed, 'active', o, nowMs);
  }
  return { resumed };
}

/** Switch the provider campaigns of these flights. Only live campaigns exist at the provider, so a dry run sends (and records) nothing. */
async function setProviderStatus(env: Env, cfg: Config, flightIds: string[], status: 'paused' | 'active', o: ControlOptions, nowMs: number) {
  if (cfg.adsMode !== 'live' || !flightIds.length) return;
  const { results } = await env.DB.prepare(`SELECT external_campaign_id AS id FROM ad_flight_allocations WHERE external_campaign_id IS NOT NULL
      AND flight_id IN (${flightIds.map(() => '?').join(', ')})`).bind(...flightIds).all<{ id: string }>();
  // bulk-status takes at most 50 campaigns per call.
  for (let i = 0; i < results.length; i += 50) {
    const ids = results.slice(i, i + 50).map(r => r.id);
    const request = await recordRequest(env.DB, {
      adapter: 'ads', operation: `ads.${status === 'paused' ? 'pause' : 'resume'}`, mode: 'live', resourceId: null,
      request: buildCampaignStatusRequest(zernioApiBase(env.ZERNIO_API_BASE), ids, status, newId(`ads:${status}`)),
    }, nowMs);
    await sendRecorded(env.DB, request, { apiKey: env.ZERNIO_API_KEY, fetcher: o.fetcher }, nowMs);
  }
}
