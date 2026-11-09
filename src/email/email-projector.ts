// Email projector: consumes domain events from outbox_events (written in the same batch as each
// state change) and queues the emails they cause in email_outbox. Never mutates outbox_events.
//
// Progress is tracked two ways:
// - email_event_receipts marks each handled event, so replays and concurrent runs are no-ops;
// - email_settings.projection_cursor is the outbox_events rowid up to which EVERY event is handled,
//   so a run only scans newer events. outbox_events rows are never deleted, so rowids are dense and
//   increase in commit order (D1 serialises writes; a VACUUM cannot renumber a dense rowid range).
// A deferred or failed event holds the cursor below itself; later events still get receipts, and
// the NOT EXISTS on receipts skips them when the deferred event is retried.
import { newId } from '../lib/ids';
import { iso } from '../lib/time';
import { EMAIL_KIND_GROUP, type EmailGroup } from './email-message-types';
import { mapEvent } from './email-event-mapping';
import { preferencesInsertStatement } from './email-preferences';
import type { EmailDraft, OutboxEvent } from './email-projection-types';

export const PROJECTION_PAGE_SIZE = 50;

interface Recipient {
  displayName: string;
  email: string | null;
  /** null when the user has no preferences row yet (every group on). */
  groups: Record<EmailGroup, boolean> | null;
}

export interface ProjectionSettings {
  start: string;
  cursor: number;
}

export async function projectionSettings(db: D1Database): Promise<ProjectionSettings> {
  const { results } = await db.prepare(`SELECT key, value FROM email_settings WHERE key IN ('projection_start', 'projection_cursor')`).all<{ key: string; value: string }>();
  const get = (k: string) => results.find(r => r.key === k)?.value;
  const start = get('projection_start');
  const cursor = Number(get('projection_cursor'));
  if (!start || !Number.isSafeInteger(cursor)) throw new Error('email_settings is missing projection_start or projection_cursor');
  return { start, cursor };
}

/** True when events newer than the cursor exist: the projector has work. */
export function hasUnprojectedEventsSql() {
  return `EXISTS (SELECT 1 FROM outbox_events WHERE rowid > (SELECT CAST(value AS INTEGER) FROM email_settings WHERE key = 'projection_cursor'))`;
}

function recipientLoader(db: D1Database) {
  const cache = new Map<string, Promise<Recipient | null>>();
  return (userId: string) => {
    let hit = cache.get(userId);
    if (!hit) {
      hit = db.prepare(`SELECT u.display_name, u.email, p.products, p.boards, p.referrals
          FROM users u LEFT JOIN email_preferences p ON p.user_id = u.id WHERE u.id = ?`).bind(userId)
        .first<{ display_name: string; email: string | null; products: number | null; boards: number | null; referrals: number | null }>()
        .then(r => r && {
          displayName: r.display_name,
          email: r.email?.trim() || null,
          groups: r.products === null ? null : { products: r.products === 1, boards: r.boards === 1, referrals: r.referrals === 1 },
        });
      cache.set(userId, hit);
    }
    return hit;
  };
}

function draftStatements(db: D1Database, d: EmailDraft, r: Recipient, now: string): D1PreparedStatement[] {
  const group = EMAIL_KIND_GROUP[d.kind];
  const skipReason = !r.email ? 'no_email' : group && r.groups && !r.groups[group] ? 'opted_out' : null;
  return [
    // Every recipient gets a preferences row (and so an unsubscribe token) with their first email.
    ...(r.groups ? [] : [preferencesInsertStatement(db, d.userId, now)]),
    db.prepare(`INSERT INTO email_outbox (id, user_id, kind, group_name, dedupe_key, to_address, data_json, status, skip_reason, attempts, next_attempt_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
      .bind(newId('eml'), d.userId, d.kind, group, d.dedupeKey, r.email, JSON.stringify(d.data), skipReason ? 'skipped' : 'pending', skipReason, now, now, now),
  ];
}

export interface ProjectionResult {
  events: number;
  queued: number;
  deferred: number;
  failed: number;
}

/** Handle one page of unprojected events. Returns what it did; DB errors on the page read or the final batch throw. */
export async function projectEmailEvents(db: D1Database, origin: string, nowMs = Date.now(), pageSize = PROJECTION_PAGE_SIZE): Promise<ProjectionResult> {
  const settings = await projectionSettings(db);
  const { results: events } = await db.prepare(`SELECT e.rowid AS seq, e.id, e.event_type, e.aggregate_id, e.payload_json, e.created_at
      FROM outbox_events e
      WHERE e.rowid > ? AND NOT EXISTS (SELECT 1 FROM email_event_receipts r WHERE r.event_id = e.id)
      ORDER BY e.rowid LIMIT ?`).bind(settings.cursor, pageSize).all<OutboxEvent>();
  const out: ProjectionResult = { events: events.length, queued: 0, deferred: 0, failed: 0 };
  if (!events.length) return out;

  const now = iso(nowMs);
  const recipient = recipientLoader(db);
  const ctx = { db, origin, nowMs, displayName: async (id: string) => (await recipient(id))?.displayName ?? null };
  const statements: D1PreparedStatement[] = [];
  let cursor = settings.cursor;
  let blocked = false;
  for (const e of events) {
    let drafts: EmailDraft[] | 'defer' = [];
    // Events from before the email feature was deployed are acknowledged without email.
    if (e.created_at >= settings.start) {
      try {
        drafts = await mapEvent(ctx, e);
      } catch (err) {
        // Left without a receipt (and holding the cursor) so the next run retries it; later events go on.
        console.error(`email projection of ${e.event_type} ${e.id} failed`, err);
        out.failed++;
        blocked = true;
        continue;
      }
    }
    if (drafts === 'defer') {
      out.deferred++;
      blocked = true;
      continue;
    }
    for (const d of drafts) {
      const r = await recipient(d.userId);
      if (!r) continue;
      statements.push(...draftStatements(db, d, r, now));
      if (!r.groups) r.groups = { products: true, boards: true, referrals: true };
      out.queued++;
    }
    statements.push(db.prepare('INSERT INTO email_event_receipts (event_id, processed_at) VALUES (?, ?) ON CONFLICT (event_id) DO NOTHING').bind(e.id, now));
    if (!blocked) cursor = e.seq;
  }
  if (cursor > settings.cursor) {
    // MAX keeps a concurrent run that got further from being moved back.
    statements.push(db.prepare(`UPDATE email_settings SET value = CAST(MAX(CAST(value AS INTEGER), ?) AS TEXT) WHERE key = 'projection_cursor'`).bind(cursor));
  }
  if (statements.length) await db.batch(statements);
  return out;
}
