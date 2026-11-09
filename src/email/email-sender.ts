// Email sender: claims due email_outbox rows, renders and delivers them, records the outcome.
// A claim is one conditional UPDATE ... RETURNING (D1 serialises writes), so two concurrent runs
// never claim the same row; the claim instant (updated_at) is the lease that guards the outcome.
import { HOUR_MS, iso } from '../lib/time';
import { meteredDb, type QueryBudget, unmetered } from './d1-query-meter';
import type { EmailGroup, EmailMessageData } from './email-message-types';
import { preferencesInsertStatement } from './email-preferences';
import { renderEmail } from './email-templates';
import { describeSendError, type EmailTransport, type OutgoingEmail, subjectPrefixFor } from './email-transport';

const MINUTE_MS = 60_000;
/** Wait after the 1st..5th failed attempt; the 6th failure is final. */
export const RETRY_BACKOFF_MS = [5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS];
export const MAX_SEND_ATTEMPTS = 6;
/** A row left in 'sending' longer than this (worker died mid-send) is claimed again. */
export const SEND_LEASE_MS = 10 * MINUTE_MS;
export const SEND_BATCH_SIZE = 25;
/** Claim batch + preferences batch + one spare, on top of one outcome write per claimed row. */
const SEND_QUERY_OVERHEAD = 3;
const MAX_ERROR_LENGTH = 500;

export interface SenderOptions {
  origin: string;
  from: string | EmailAddress;
  replyTo?: string;
  nowMs?: number;
  limit?: number;
  budget?: QueryBudget;
}

interface ClaimedRow {
  id: string;
  user_id: string;
  kind: string;
  group_name: EmailGroup | null;
  to_address: string | null;
  data_json: string;
  attempts: number;
  updated_at: string;
}

interface PreferencesRow {
  user_id: string;
  products: number;
  boards: number;
  referrals: number;
  unsubscribe_token: string;
}

export interface SendResult {
  claimed: number;
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
}

/** True when the sender has work (binds ?1 = now, ?2 = lease expiry): a due pending row or an expired lease. */
export const hasDueEmailsSql = () =>
  `(EXISTS (SELECT 1 FROM email_outbox WHERE status = 'pending' AND next_attempt_at <= ?1) OR EXISTS (SELECT 1 FROM email_outbox WHERE status = 'sending' AND updated_at < ?2))`;

async function claim(db: D1Database, now: string, leaseExpiredBefore: string, limit: number): Promise<ClaimedRow[]> {
  const [, claimed] = await db.batch<ClaimedRow>([
    // A row whose lease expired after its last allowed attempt is not tried again.
    db.prepare(`UPDATE email_outbox SET status = 'failed', last_error = COALESCE(last_error, 'send lease expired'), updated_at = ?
                WHERE status = 'sending' AND updated_at < ? AND attempts >= ?`).bind(now, leaseExpiredBefore, MAX_SEND_ATTEMPTS),
    // attempts counts claims, so a worker that keeps dying mid-send still ends in 'failed'.
    db.prepare(`UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, updated_at = ?1
                WHERE id IN (SELECT id FROM email_outbox
                             WHERE (status = 'pending' AND next_attempt_at <= ?1) OR (status = 'sending' AND updated_at < ?2)
                             ORDER BY next_attempt_at LIMIT ?3)
                RETURNING id, user_id, kind, group_name, to_address, data_json, attempts, updated_at`).bind(now, leaseExpiredBefore, limit),
  ]);
  return claimed.results;
}

/**
 * Current preferences of every claimed user in one batch (re-read right before sending: the user
 * may have opted out since projection), creating missing rows so every grouped email has a token.
 */
async function preferencesOf(db: D1Database, userIds: string[], now: string): Promise<Map<string, PreferencesRow>> {
  const ids = [...new Set(userIds)];
  const results = await db.batch<PreferencesRow>([
    ...ids.map(id => preferencesInsertStatement(db, id, now)),
    db.prepare(`SELECT user_id, products, boards, referrals, unsubscribe_token FROM email_preferences WHERE user_id IN (${ids.map(() => '?').join(', ')})`).bind(...ids),
  ]);
  return new Map(results[results.length - 1].results.map(r => [r.user_id, r]));
}

/** Settle a claimed row; the WHERE on the lease makes a late finisher unable to overwrite a re-claim. */
function finish(db: D1Database, row: ClaimedRow, set: string, ...binds: unknown[]) {
  return db.prepare(`UPDATE email_outbox SET ${set} WHERE id = ? AND status = 'sending' AND updated_at = ?`).bind(...binds, row.id, row.updated_at).run();
}

const truncate = (s: string) => (s.length > MAX_ERROR_LENGTH ? `${s.slice(0, MAX_ERROR_LENGTH - 1)}…` : s);

function compose(row: ClaimedRow, prefs: PreferencesRow, o: SenderOptions): OutgoingEmail {
  const unsubscribeUrl = row.group_name ? `${o.origin}/email/unsubscribe?t=${encodeURIComponent(prefs.unsubscribe_token)}&g=${row.group_name}` : null;
  const data = JSON.parse(row.data_json) as EmailMessageData;
  const rendered = renderEmail(data, { origin: o.origin, unsubscribeUrl, preferencesUrl: `${o.origin}/account`, subjectPrefix: subjectPrefixFor(o.origin) });
  // Mailbox providers only honour https one-click unsubscribe URLs; a dev origin gets the body link only.
  const oneClick = unsubscribeUrl && unsubscribeUrl.startsWith('https://');
  return {
    from: o.from, to: row.to_address!, subject: rendered.subject, html: rendered.html, text: rendered.text,
    ...(o.replyTo ? { replyTo: o.replyTo } : {}),
    ...(oneClick ? { headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
  };
}

/**
 * Deliver due emails: at most `limit`, and never more than the query budget can record (one
 * outcome write per claimed row is reserved before claiming, so a delivered email is always
 * recorded). Each row's failure is recorded on the row; only claim errors throw.
 */
export async function sendDueEmails(rawDb: D1Database, transport: EmailTransport, o: SenderOptions): Promise<SendResult> {
  const budget = o.budget ?? unmetered();
  const db = meteredDb(rawDb, budget);
  const out: SendResult = { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0 };
  const limit = Math.min(o.limit ?? SEND_BATCH_SIZE, budget.remaining - SEND_QUERY_OVERHEAD);
  if (limit <= 0) return out;
  const nowMs = o.nowMs ?? Date.now();
  const now = iso(nowMs);
  const rows = await claim(db, now, iso(nowMs - SEND_LEASE_MS), limit);
  out.claimed = rows.length;
  if (!rows.length) return out;
  const prefs = await preferencesOf(db, rows.map(r => r.user_id), now);
  for (const row of rows) {
    let messageId: string;
    try {
      const p = prefs.get(row.user_id);
      if (!p) throw new Error(`email preferences for ${row.user_id} are missing`);
      const skipReason = !row.to_address ? 'no_email' : row.group_name && p[row.group_name] !== 1 ? 'opted_out' : null;
      if (skipReason) {
        await finish(db, row, `status = 'skipped', skip_reason = ?, updated_at = ?`, skipReason, now);
        out.skipped++;
        continue;
      }
      ({ messageId } = await transport.send(compose(row, p, o)));
    } catch (e) {
      const { error, permanent } = describeSendError(e);
      const final = permanent || row.attempts >= MAX_SEND_ATTEMPTS;
      console.error(`email ${row.id} (${row.kind}) attempt ${row.attempts} failed${final ? ' permanently' : ''}: ${error}`);
      try {
        if (final) {
          await finish(db, row, `status = 'failed', last_error = ?, updated_at = ?`, truncate(error), now);
          out.failed++;
        } else {
          const next = iso(nowMs + RETRY_BACKOFF_MS[Math.min(row.attempts, RETRY_BACKOFF_MS.length) - 1]);
          await finish(db, row, `status = 'pending', last_error = ?, next_attempt_at = ?, updated_at = ?`, truncate(error), next, now);
          out.retried++;
        }
      } catch (writeErr) {
        // The lease expires and the row is claimed again later.
        console.error(`email ${row.id}: recording the failure failed`, writeErr);
      }
      continue;
    }
    try {
      await finish(db, row, `status = 'sent', provider_message_id = ?, last_error = NULL, sent_at = ?, updated_at = ?`, messageId || null, now, now);
      out.sent++;
    } catch (writeErr) {
      // Delivered but not recorded: the lease expiry will send it again, which beats losing it.
      console.error(`email ${row.id}: sent as ${messageId} but recording it failed`, writeErr);
    }
  }
  return out;
}
