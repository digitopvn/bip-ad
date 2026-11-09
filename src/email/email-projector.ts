// Email projector: consumes domain events from outbox_events (written in the same batch as each
// state change) and queues the emails they cause in email_outbox. Never mutates outbox_events.
//
// Progress (email-projection-state.ts):
// - email_event_receipts marks each handled event, so replays and concurrent runs are no-ops;
// - projection_cursor is the outbox_events rowid up to which EVERY event is handled, so a page
//   only scans newer events. outbox_events rows are never deleted, so rowids are dense and increase
//   in commit order (D1 serialises writes; a VACUUM cannot renumber a dense rowid range);
// - email_event_deferrals holds events to look at again later (a lock waiting for its other
//   boards, a failed mapping). They hold the cursor below themselves but are skipped until due,
//   and projection_high records how far the projector has looked, so they are not pending work.
import { newId } from '../lib/ids';
import { iso } from '../lib/time';
import { type QueryBudget, meteredDb, unmetered } from './d1-query-meter';
import { mapEvent } from './email-event-mapping';
import { EMAIL_KIND_GROUP, type EmailGroup } from './email-message-types';
import { preferencesInsertStatement } from './email-preferences';
import {
  advanceHighStatement, catchUpCursorStatement, DEFER_RETRY_MS, deferralStatement, FAILURE_RETRY_MS, MAX_EVENT_FAILURES, projectionSettings, receiptStatements,
} from './email-projection-state';
import type { EmailDraft, OutboxEvent } from './email-projection-types';

export const PROJECTION_PAGE_SIZE = 50;
/** Queries one event may need (mapping, lock snapshots, recipients) plus the final batch. */
const EVENT_QUERY_RESERVE = 8;
/** D1 allows 100 bound parameters per query. */
const IN_CHUNK = 90;

interface Recipient {
  displayName: string;
  email: string | null;
  /** null when the user has no preferences row yet (every group on). */
  groups: Record<EmailGroup, boolean> | null;
}

/** Users with their preferences, loaded in one query per chunk of ids and cached for the page. */
function recipientCache(db: D1Database) {
  const cache = new Map<string, Recipient | null>();
  async function load(ids: string[]) {
    const missing = [...new Set(ids)].filter(id => !cache.has(id));
    for (let i = 0; i < missing.length; i += IN_CHUNK) {
      const chunk = missing.slice(i, i + IN_CHUNK);
      const { results } = await db.prepare(`SELECT u.id, u.display_name, u.email, p.products, p.boards, p.referrals
          FROM users u LEFT JOIN email_preferences p ON p.user_id = u.id WHERE u.id IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk)
        .all<{ id: string; display_name: string; email: string | null; products: number | null; boards: number | null; referrals: number | null }>();
      for (const id of chunk) cache.set(id, null);
      for (const r of results) {
        cache.set(r.id, {
          displayName: r.display_name,
          email: r.email?.trim() || null,
          groups: r.products === null ? null : { products: r.products === 1, boards: r.boards === 1, referrals: r.referrals === 1 },
        });
      }
    }
  }
  return { load, get: (id: string) => cache.get(id) ?? null };
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
  /** Events acknowledged without email after MAX_EVENT_FAILURES failed mappings. */
  abandoned: number;
  /** Highest rowid looked at; the next page of the same run starts after it. */
  lastSeq: number;
  /** The query budget ran out before the page was finished. */
  budgetExhausted: boolean;
}

export interface ProjectionOptions {
  pageSize?: number;
  budget?: QueryBudget;
  /** Start after this rowid: `lastSeq` of the previous page of the same run, which handled or deferred everything up to it. */
  afterSeq?: number;
}

type PageEvent = OutboxEvent & { failures: number | null };

/** Handle one page of events. DB errors reading the page or writing its batch throw. */
export async function projectEmailEvents(rawDb: D1Database, origin: string, nowMs = Date.now(), o: ProjectionOptions = {}): Promise<ProjectionResult> {
  const budget = o.budget ?? unmetered();
  const db = meteredDb(rawDb, budget);
  const now = iso(nowMs);
  const settings = await projectionSettings(db);
  const after = Math.max(settings.cursor, o.afterSeq ?? 0);
  // Deferred events are skipped until due, so a page is never filled by events that cannot progress.
  const { results: events } = await db.prepare(`SELECT e.rowid AS seq, e.id, e.event_type, e.aggregate_id, e.payload_json, e.created_at, d.failures
      FROM outbox_events e LEFT JOIN email_event_deferrals d ON d.event_id = e.id
      WHERE e.rowid > ? AND NOT EXISTS (SELECT 1 FROM email_event_receipts r WHERE r.event_id = e.id)
        AND (d.event_id IS NULL OR d.retry_after <= ?)
      ORDER BY e.rowid LIMIT ?`).bind(after, now, o.pageSize ?? PROJECTION_PAGE_SIZE).all<PageEvent>();
  const out: ProjectionResult = { events: events.length, queued: 0, deferred: 0, failed: 0, abandoned: 0, lastSeq: after, budgetExhausted: false };
  if (!events.length) return out;

  const recipients = recipientCache(db);
  const ctx = {
    db, origin, nowMs,
    displayNames: async (ids: string[]) => {
      await recipients.load(ids);
      return new Map(ids.map(id => [id, recipients.get(id)?.displayName ?? null]));
    },
  };
  const statements: D1PreparedStatement[] = [];
  for (const e of events) {
    if (!budget.allows(EVENT_QUERY_RESERVE)) {
      out.budgetExhausted = true;
      break;
    }
    let drafts: EmailDraft[] | 'defer' = [];
    // Events from before the email feature was deployed are acknowledged without email.
    if (e.created_at >= settings.start) {
      try {
        drafts = await mapEvent(ctx, e);
      } catch (err) {
        const failures = (e.failures ?? 0) + 1;
        out.failed++;
        if (failures < MAX_EVENT_FAILURES) {
          console.error(`email projection of ${e.event_type} ${e.id} failed (${failures}/${MAX_EVENT_FAILURES})`, err);
          const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          statements.push(deferralStatement(db, e.id, iso(nowMs + FAILURE_RETRY_MS), failures, message, now));
          out.lastSeq = e.seq;
          continue;
        }
        // One event must not block the projector forever: acknowledge it without email.
        console.error(`email projection of ${e.event_type} ${e.id} abandoned after ${failures} failures; no email sent`, err);
        out.abandoned++;
      }
    }
    if (drafts === 'defer') {
      out.deferred++;
      statements.push(deferralStatement(db, e.id, iso(nowMs + DEFER_RETRY_MS), e.failures ?? 0, 'waiting for the other boards of the lock', now));
      out.lastSeq = e.seq;
      continue;
    }
    await recipients.load(drafts.map(d => d.userId));
    for (const d of drafts) {
      const r = recipients.get(d.userId);
      if (!r) continue;
      statements.push(...draftStatements(db, d, r, now));
      r.groups ??= { products: true, boards: true, referrals: true };
      out.queued++;
    }
    statements.push(...receiptStatements(db, e.id, now));
    out.lastSeq = e.seq;
  }
  if (out.lastSeq > settings.high) statements.push(advanceHighStatement(db, out.lastSeq));
  if (statements.length) await db.batch([...statements, catchUpCursorStatement(db)]);
  return out;
}
