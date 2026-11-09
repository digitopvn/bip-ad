// Projector bookkeeping in email_settings and email_event_deferrals: scan positions, the run lease,
// per-event retry state, and the cheap "is there anything to do?" probe.
import { iso } from '../lib/time';

/** A lock result waiting for its other boards is looked at again after this. */
export const DEFER_RETRY_MS = 10 * 60_000;
/** A failed mapping is retried after this. */
export const FAILURE_RETRY_MS = 5 * 60_000;
/** After this many failed mappings of one event it is acknowledged without email. */
export const MAX_EVENT_FAILURES = 10;
/** One projector at a time; a crashed run frees the lease after this. */
export const PROJECTION_LEASE_MS = 30_000;

export interface ProjectionSettings {
  /** Events created before this instant are never emailed. */
  start: string;
  /** Every event at or below this rowid is handled. */
  cursor: number;
  /** Every event at or below this rowid is handled or deferred. */
  high: number;
}

export async function projectionSettings(db: D1Database): Promise<ProjectionSettings> {
  const { results } = await db.prepare(`SELECT key, value FROM email_settings WHERE key IN ('projection_start', 'projection_cursor', 'projection_high')`)
    .all<{ key: string; value: string }>();
  const get = (k: string) => results.find(r => r.key === k)?.value;
  const start = get('projection_start');
  const cursor = Number(get('projection_cursor'));
  const high = Number(get('projection_high'));
  if (!start || !Number.isSafeInteger(cursor) || !Number.isSafeInteger(high)) throw new Error('email_settings is missing projection_start, projection_cursor or projection_high');
  return { start, cursor, high };
}

/** Raise projection_high to `seq`; MAX keeps a run that got further from being moved back. */
export function advanceHighStatement(db: D1Database, seq: number) {
  return db.prepare(`UPDATE email_settings SET value = CAST(MAX(CAST(value AS INTEGER), ?) AS TEXT) WHERE key = 'projection_high'`).bind(seq);
}

/**
 * Move projection_cursor to just below the oldest event without a receipt, or to the newest event
 * when every event is handled. Computed from the receipts (run last in the page's batch), so it
 * also passes events other pages or runs handled, and never passes a deferred or skipped one.
 */
export function catchUpCursorStatement(db: D1Database) {
  return db.prepare(`UPDATE email_settings SET value = CAST(MAX(CAST(value AS INTEGER), COALESCE(
      (SELECT MIN(e.rowid) - 1 FROM outbox_events e
        WHERE e.rowid > (SELECT CAST(value AS INTEGER) FROM email_settings WHERE key = 'projection_cursor')
          AND NOT EXISTS (SELECT 1 FROM email_event_receipts r WHERE r.event_id = e.id)),
      (SELECT MAX(rowid) FROM outbox_events), 0)) AS TEXT) WHERE key = 'projection_cursor'`);
}

/**
 * Record that an event must be looked at again after `retryAfter`. Written only while the event
 * has no receipt, so a run that lost a race cannot resurrect a handled event as pending work.
 */
export function deferralStatement(db: D1Database, eventId: string, retryAfter: string, failures: number, lastError: string | null, now: string) {
  return db.prepare(`INSERT INTO email_event_deferrals (event_id, retry_after, failures, last_error, updated_at)
      SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM email_event_receipts WHERE event_id = ?1)
      ON CONFLICT (event_id) DO UPDATE SET retry_after = excluded.retry_after, failures = excluded.failures, last_error = excluded.last_error, updated_at = excluded.updated_at`)
    .bind(eventId, retryAfter, failures, lastError, now);
}

export function receiptStatements(db: D1Database, eventId: string, now: string) {
  return [
    db.prepare('INSERT INTO email_event_receipts (event_id, processed_at) VALUES (?, ?) ON CONFLICT (event_id) DO NOTHING').bind(eventId, now),
    db.prepare('DELETE FROM email_event_deferrals WHERE event_id = ?').bind(eventId),
  ];
}

/** SQL (binds ?1 = now) true when an event was never looked at, or a deferred one is due again. */
export const hasProjectionWorkSql = () =>
  `(EXISTS (SELECT 1 FROM outbox_events WHERE rowid > (SELECT CAST(value AS INTEGER) FROM email_settings WHERE key = 'projection_high'))
    OR EXISTS (SELECT 1 FROM email_event_deferrals WHERE retry_after <= ?1))`;

/** Take the projection lease. Returns its expiry when taken, null while another run holds it. */
export async function acquireProjectionLease(db: D1Database, nowMs: number): Promise<string | null> {
  const until = iso(nowMs + PROJECTION_LEASE_MS);
  const r = await db.prepare(`UPDATE email_settings SET value = ? WHERE key = 'projection_lease_until' AND value <= ?`).bind(until, iso(nowMs)).run();
  return r.meta.changes > 0 ? until : null;
}

/** Give the lease back early so the next run need not wait for it to expire; only our own lease is released. */
export async function releaseProjectionLease(db: D1Database, until: string) {
  await db.prepare(`UPDATE email_settings SET value = ? WHERE key = 'projection_lease_until' AND value = ?`).bind(iso(0), until).run();
}
