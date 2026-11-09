// Email preference groups per user and the one-click unsubscribe token. The row is created lazily
// (first email projected for the user, first visit of the account page, first save).
import { randomToken } from '../lib/ids';
import { iso } from '../lib/time';
import { EMAIL_GROUPS, type EmailGroup } from './email-message-types';

export type GroupSwitches = Record<EmailGroup, boolean>;

export interface EmailPreferences extends GroupSwitches {
  userId: string;
  unsubscribeToken: string;
}

interface PreferencesRow {
  user_id: string;
  products: number;
  boards: number;
  referrals: number;
  unsubscribe_token: string;
}

/** All groups on: the state of a user who never changed anything. */
export const DEFAULT_SWITCHES: GroupSwitches = { products: true, boards: true, referrals: true };

/** Unsubscribe tokens are randomToken(24): 32 base64url characters. Anything else is rejected before a query. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

const toPreferences = (r: PreferencesRow): EmailPreferences => ({
  userId: r.user_id,
  unsubscribeToken: r.unsubscribe_token,
  products: r.products === 1,
  boards: r.boards === 1,
  referrals: r.referrals === 1,
});

export const isEmailGroup = (s: string): s is EmailGroup => (EMAIL_GROUPS as readonly string[]).includes(s);

/** Create the preferences row with every group on, unless it exists. Safe to repeat and to race. */
export function preferencesInsertStatement(db: D1Database, userId: string, now: string) {
  return db.prepare('INSERT INTO email_preferences (user_id, unsubscribe_token, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING')
    .bind(userId, randomToken(24), now);
}

export async function getPreferences(db: D1Database, userId: string): Promise<EmailPreferences | null> {
  const r = await db.prepare('SELECT user_id, products, boards, referrals, unsubscribe_token FROM email_preferences WHERE user_id = ?').bind(userId).first<PreferencesRow>();
  return r ? toPreferences(r) : null;
}

export async function ensurePreferences(db: D1Database, userId: string, nowMs = Date.now()): Promise<EmailPreferences> {
  const found = await getPreferences(db, userId);
  if (found) return found;
  await preferencesInsertStatement(db, userId, iso(nowMs)).run();
  const created = await getPreferences(db, userId);
  if (!created) throw new Error(`email preferences for ${userId} could not be created`);
  return created;
}

/** Save the account page switches. */
export async function savePreferences(db: D1Database, userId: string, s: GroupSwitches, nowMs = Date.now()) {
  const now = iso(nowMs);
  await db.batch([
    preferencesInsertStatement(db, userId, now),
    db.prepare('UPDATE email_preferences SET products = ?, boards = ?, referrals = ?, updated_at = ? WHERE user_id = ?')
      .bind(s.products ? 1 : 0, s.boards ? 1 : 0, s.referrals ? 1 : 0, now, userId),
  ]);
}

export async function findPreferencesByToken(db: D1Database, token: string): Promise<EmailPreferences | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const r = await db.prepare('SELECT user_id, products, boards, referrals, unsubscribe_token FROM email_preferences WHERE unsubscribe_token = ?').bind(token).first<PreferencesRow>();
  return r ? toPreferences(r) : null;
}

/** Switch groups off for the holder of an unsubscribe token. Returns false for an unknown token. */
export async function unsubscribeByToken(db: D1Database, token: string, groups: readonly EmailGroup[], nowMs = Date.now()): Promise<boolean> {
  if (!TOKEN_SHAPE.test(token) || !groups.length) return false;
  // Column names come from the fixed EMAIL_GROUPS list, never from the request.
  const sets = groups.filter(isEmailGroup).map(g => `${g} = 0`).join(', ');
  const r = await db.prepare(`UPDATE email_preferences SET ${sets}, updated_at = ? WHERE unsubscribe_token = ?`).bind(iso(nowMs), token).run();
  return r.meta.changes > 0;
}
