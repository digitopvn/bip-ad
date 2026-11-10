// Operator retry of a dead-lettered adapter call: resends the stored request with its original
// idempotency key (Zernio returns the original object if the first attempt actually landed) and,
// on success, applies the same effect the first attempt would have had.
import type { Config } from '../domain/config';
import { DomainError } from '../domain/errors';
import { decisionStatement } from '../domain/ledger';
import type { Env } from '../env';
import { iso } from '../lib/time';
import { publicationFailedStatements, publicationPublishedStatements } from '../social/social-publisher';
import { type AdapterRequestRow, sendRecorded } from './adapter-call-log';
import { allocationSentStatements } from './ads-flight-operations';
import { readKillSwitch } from './ads-safety-controls';

export async function retryDeadLetter(env: Env, cfg: Config, deadLetterId: string, o: { actor: string; nowMs?: number; fetcher?: typeof fetch }) {
  const db = env.DB;
  const nowMs = o.nowMs ?? Date.now();
  const now = iso(nowMs);
  const row = await db.prepare(`SELECT r.*, d.status AS dl_status FROM adapter_dead_letters d JOIN adapter_requests r ON r.id = d.request_id WHERE d.id = ?`)
    .bind(deadLetterId).first<AdapterRequestRow & { dl_status: string }>();
  if (!row) throw new DomainError('not_found', 'Dead letter not found', 404);
  if (row.dl_status !== 'open') throw new DomainError('not_open', 'This dead letter is already resolved', 409);
  // The modes may have been switched off since the call failed: a retry never sends what the current configuration forbids.
  if (row.adapter === 'social' && cfg.socialMode !== 'live') throw new DomainError('social_not_live', 'SOCIAL_MODE is not live; nothing was sent', 409);
  if (row.adapter === 'ads') {
    if (cfg.adsMode !== 'live') throw new DomainError('ads_not_live', 'ADS_MODE is not live (or not approved); nothing was sent', 409);
    if ((await readKillSwitch(db, cfg)).engaged && row.operation === 'ads.create') throw new DomainError('kill_switch_engaged', 'The ads kill switch is on; nothing was sent', 409);
  }
  const resource = row.resource_id;
  const onSuccess = (response: unknown): D1PreparedStatement[] => {
    const effect = row.operation === 'social.publish' && resource ? publicationPublishedStatements(db, resource, response)
      : row.operation === 'ads.create' && resource ? allocationSentStatements(db, resource, response, now) : [];
    return [...effect, decisionStatement(db, { actor: o.actor, action: 'adapters.retry', decision: 'allow', reasons: ['RETRY_SUCCEEDED'], policy: 'adapters-v1', resourceId: row.id, result: { operation: row.operation } }, now)];
  };
  const onFailure = (): D1PreparedStatement[] => [
    ...(row.operation === 'social.publish' && resource ? publicationFailedStatements(db, resource) : []),
    decisionStatement(db, { actor: o.actor, action: 'adapters.retry', decision: 'defer', reasons: ['RETRY_FAILED'], policy: 'adapters-v1', resourceId: row.id, result: { operation: row.operation } }, now),
  ];
  const outcome = await sendRecorded(db, row, { apiKey: env.ZERNIO_API_KEY, fetcher: o.fetcher }, nowMs, onSuccess, onFailure);
  return { dead_letter_id: deadLetterId, request_id: row.id, operation: row.operation, ok: outcome.ok, ...(outcome.ok ? { status: outcome.status } : { error: outcome.error }) };
}
