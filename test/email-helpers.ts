import { projectEmailEvents } from '../src/email/email-projector';
import type { EmailTransport, OutgoingEmail } from '../src/email/email-transport';
import { newId } from '../src/lib/ids';
import { iso } from '../src/lib/time';
import { db } from './helpers';

export const ORIGIN = 'https://bip.test';

export interface EmailRow {
  id: string;
  user_id: string;
  kind: string;
  group_name: string | null;
  dedupe_key: string;
  to_address: string | null;
  data_json: string;
  status: string;
  skip_reason: string | null;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  provider_message_id: string | null;
  sent_at: string | null;
  updated_at: string;
}

/** Tests drive domain functions at past instants; let those events count as post-deploy. */
export async function projectFromTheBeginning() {
  await db().prepare(`UPDATE email_settings SET value = '2000-01-01T00:00:00.000Z' WHERE key = 'projection_start'`).run();
}

/** Project until no unhandled event is left (bounded). */
export async function projectAll(nowMs = Date.now()) {
  for (let i = 0; i < 50; i++) {
    const r = await projectEmailEvents(db(), ORIGIN, nowMs);
    if (r.events === 0 || r.events === r.deferred) return;
  }
  throw new Error('projection did not drain');
}

export async function emailsOf(userId: string, kind?: string) {
  const { results } = await db().prepare(`SELECT * FROM email_outbox WHERE user_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY created_at, rowid`)
    .bind(...(kind ? [userId, kind] : [userId])).all<EmailRow>();
  return results;
}

export const dataOf = <T = Record<string, unknown>>(row: EmailRow) => JSON.parse(row.data_json) as T;

/** Records every message; `fail` makes send reject (with `fail` itself when it is an Error), `delayMs` widens race windows. */
export function fakeTransport(opts: { fail?: boolean | Error; delayMs?: number } = {}) {
  const sent: OutgoingEmail[] = [];
  const transport: EmailTransport = {
    async send(m) {
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      if (opts.fail) throw opts.fail instanceof Error ? opts.fail : new Error('provider unavailable');
      sent.push(m);
      return { messageId: newId('msg') };
    },
  };
  return { sent, transport };
}

/** Insert an email_outbox row due at `dueMs` (bypassing the projector). */
export async function queue(userId: string, kind: 'welcome' | 'product_decision', dueMs: number, extra: Partial<EmailRow> = {}) {
  const id = newId('eml');
  const data = kind === 'welcome'
    ? { kind, displayName: 'Sam' }
    : { kind, displayName: 'Sam', productName: 'Thing', productUrl: `${ORIGIN}/p/thing`, outcome: 'published', reason: '' };
  await db().prepare(`INSERT INTO email_outbox (id, user_id, kind, group_name, dedupe_key, to_address, data_json, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, userId, kind, kind === 'welcome' ? null : 'products', `test:${id}`, extra.to_address === undefined ? 'sam@example.test' : extra.to_address,
      JSON.stringify(data), extra.status ?? 'pending', extra.attempts ?? 0, iso(dueMs), iso(dueMs), extra.updated_at ?? iso(dueMs)).run();
  return id;
}
export const row = async (id: string) => (await db().prepare('SELECT * FROM email_outbox WHERE id = ?').bind(id).first<EmailRow>())!;
