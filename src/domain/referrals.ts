// Referral codes, attribution and successful-referral qualification (policy ref-v1, ADR-0005).
import { newId } from '../lib/ids';
import { iso } from '../lib/time';
import { type Config, COMMISSION_SHARE_BPS, REFERRAL_POLICY_VERSION } from './config';
import { isConstraintError } from './errors';
import { outboxStatement } from './ledger';

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export async function getOrCreateReferralCode(db: D1Database, userId: string, nowMs = Date.now()): Promise<string> {
  const existing = await db.prepare('SELECT code FROM referral_codes WHERE user_id = ?').bind(userId).first<{ code: string }>();
  if (existing) return existing.code;
  for (let i = 0; i < 5; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const code = [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    try {
      await db.prepare('INSERT INTO referral_codes (id, user_id, code, created_at) VALUES (?, ?, ?, ?)').bind(newId('rfc'), userId, code, iso(nowMs)).run();
      return code;
    } catch (e) {
      if (!isConstraintError(e)) throw e;
      const raced = await db.prepare('SELECT code FROM referral_codes WHERE user_id = ?').bind(userId).first<{ code: string }>();
      if (raced) return raced.code;
    }
  }
  throw new Error('could not allocate referral code');
}

export const isReferralCodeShape = (s: string) => /^[a-z0-9]{6,16}$/.test(s);

/**
 * Attribute a newly created account to the referrer whose code it arrived with.
 * One referrer per account (UNIQUE referred_user_id), set once at signup, never replaced.
 * Self-referral and same-email accounts are rejected.
 */
export async function attributeSignup(db: D1Database, cfg: Config, newUserId: string, code: string, clickedAtMs: number, nowMs = Date.now()): Promise<'attributed' | 'rejected' | 'ignored'> {
  if (!isReferralCodeShape(code)) return 'ignored';
  if (nowMs - clickedAtMs > cfg.referralAttributionMs) return 'ignored';
  const ref = await db.prepare(`SELECT rc.id, rc.user_id, u.email AS ref_email, n.email AS new_email
      FROM referral_codes rc JOIN users u ON u.id = rc.user_id JOIN users n ON n.id = ?
      WHERE rc.code = ? AND rc.status = 'active'`).bind(newUserId, code).first<{ id: string; user_id: string; ref_email: string | null; new_email: string | null }>();
  if (!ref) return 'ignored';
  const self = ref.user_id === newUserId || (ref.ref_email && ref.new_email && ref.ref_email.toLowerCase() === ref.new_email.toLowerCase());
  if (self) return 'rejected';
  try {
    const id = newId('rat');
    await db.batch([
      db.prepare(`INSERT INTO referral_attributions (id, referred_user_id, referrer_user_id, referral_code_id, attribution_source, attributed_at)
                  VALUES (?, ?, ?, ?, 'signed_link', ?)`).bind(id, newUserId, ref.user_id, ref.id, iso(nowMs)),
      outboxStatement(db, 'ReferralAttributed', id, { referrer: ref.user_id }, iso(nowMs)),
    ]);
    return 'attributed';
  } catch (e) {
    if (isConstraintError(e)) return 'ignored';
    throw e;
  }
}

export interface ReferralQualification {
  attributionId: string;
  referrerUserId: string;
  commissionMinor: number;
}

/**
 * Whether this settlement qualifies the buyer as a successful referral (ref-v1):
 * the buyer has an active attribution, has never qualified before, and pays external cash.
 * Commission is 5% of the external cash portion of that first qualifying bid only.
 */
export async function referralQualification(db: D1Database, buyerId: string, cashMinor: number): Promise<ReferralQualification | null> {
  if (cashMinor <= 0) return null;
  const row = await db.prepare(`SELECT a.id, a.referrer_user_id FROM referral_attributions a
      JOIN users r ON r.id = a.referrer_user_id
      WHERE a.referred_user_id = ? AND a.status = 'active' AND r.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM successful_referrals s WHERE s.referred_user_id = a.referred_user_id)`)
    .bind(buyerId).first<{ id: string; referrer_user_id: string }>();
  if (!row) return null;
  return { attributionId: row.id, referrerUserId: row.referrer_user_id, commissionMinor: Math.floor((cashMinor * COMMISSION_SHARE_BPS) / 10000) };
}

export function qualificationStatements(db: D1Database, cfg: Config, q: ReferralQualification, buyerId: string, intentId: string, currency: string, cashMinor: number, confirmedMs: number) {
  const srId = newId('srf');
  const vestAt = iso(confirmedMs + cfg.referralHoldMs);
  const now = iso(confirmedMs);
  return [
    db.prepare(`INSERT INTO successful_referrals (id, attribution_id, referrer_user_id, referred_user_id, first_qualifying_bid_intent_id, qualified_at, vest_at, status, policy_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).bind(srId, q.attributionId, q.referrerUserId, buyerId, intentId, now, vestAt, REFERRAL_POLICY_VERSION),
    db.prepare(`INSERT INTO referral_commissions (id, successful_referral_id, qualifying_bid_intent_id, referrer_user_id, currency, eligible_base_minor, commission_minor, state, vest_at, policy_version, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).bind(newId('com'), srId, intentId, q.referrerUserId, currency, cashMinor, q.commissionMinor, vestAt, REFERRAL_POLICY_VERSION, now),
    outboxStatement(db, 'ReferralQualified', srId, { referrer: q.referrerUserId, intentId }, now),
  ];
}

export async function referralStats(db: D1Database, userId: string) {
  const r = await db.prepare(`SELECT
      SUM(CASE WHEN status = 'vested' THEN 1 ELSE 0 END) AS successful,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM successful_referrals WHERE referrer_user_id = ?`).bind(userId).first<{ successful: number | null; pending: number | null }>();
  const attributed = await db.prepare('SELECT COUNT(*) AS n FROM referral_attributions WHERE referrer_user_id = ? AND status = \'active\'').bind(userId).first<{ n: number }>();
  const { results: commissions } = await db.prepare(`SELECT currency, state, SUM(commission_minor) AS total FROM referral_commissions
      WHERE referrer_user_id = ? GROUP BY currency, state`).bind(userId).all<{ currency: string; state: string; total: number }>();
  return { successful: r?.successful ?? 0, pending: r?.pending ?? 0, attributedAccounts: attributed?.n ?? 0, commissions };
}
