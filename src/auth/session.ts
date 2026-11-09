// Web sessions (KV-backed, opaque cookie), user upsert and the signed referral cookie.
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { outboxStatement } from '../domain/ledger';
import type { Env } from '../env';
import { newId, randomToken } from '../lib/ids';
import { sign, unsign } from '../lib/crypto';
import { iso } from '../lib/time';
import type { UpstreamIdentity } from './upstream';

const SESSION_COOKIE = 'bip_session';
const REF_COOKIE = 'bip_ref';
const SESSION_TTL = 30 * 86400;

export interface Session {
  userId: string;
  csrf: string;
}

export interface UserRow {
  id: string;
  display_name: string;
  avatar_url: string | null;
  email: string | null;
  status: string;
}

type C = Context<{ Bindings: Env }>;
const secure = (c: C) => new URL(c.req.url).protocol === 'https:';

export async function createSession(c: C, userId: string) {
  const id = randomToken(24);
  const s: Session = { userId, csrf: randomToken(18) };
  await c.env.OAUTH_KV.put(`session:${id}`, JSON.stringify(s), { expirationTtl: SESSION_TTL });
  setCookie(c, SESSION_COOKIE, id, { path: '/', httpOnly: true, secure: secure(c), sameSite: 'Lax', maxAge: SESSION_TTL });
}

export async function getSession(c: C): Promise<Session | null> {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id || id.length > 64) return null;
  return c.env.OAUTH_KV.get<Session>(`session:${id}`, 'json');
}

export async function destroySession(c: C) {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) await c.env.OAUTH_KV.delete(`session:${id}`);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export async function getUser(db: D1Database, id: string) {
  return db.prepare('SELECT id, display_name, avatar_url, email, status FROM users WHERE id = ?').bind(id).first<UserRow>();
}

/** Find or create the account for an upstream identity. Returns whether it was created now. */
export async function upsertUser(db: D1Database, ident: UpstreamIdentity, nowMs = Date.now()): Promise<{ user: UserRow; created: boolean }> {
  const found = await db.prepare(`SELECT u.id FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.provider_user_id = ?`)
    .bind(ident.provider, ident.providerUserId).first<{ id: string }>();
  if (found) {
    await db.prepare('UPDATE users SET display_name = ?, avatar_url = ?, email = COALESCE(?, email) WHERE id = ?').bind(ident.displayName, ident.avatarUrl, ident.email, found.id).run();
    return { user: (await getUser(db, found.id))!, created: false };
  }
  const id = newId('usr');
  const now = iso(nowMs);
  try {
    await db.batch([
      db.prepare('INSERT INTO users (id, display_name, avatar_url, email, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, ident.displayName, ident.avatarUrl, ident.email, now),
      db.prepare('INSERT INTO user_identities (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)').bind(ident.provider, ident.providerUserId, id, now),
      // Drives the welcome email (src/email/).
      outboxStatement(db, 'UserCreated', id, {}, now),
    ]);
    return { user: (await getUser(db, id))!, created: true };
  } catch {
    const raced = await db.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND provider_user_id = ?').bind(ident.provider, ident.providerUserId).first<{ user_id: string }>();
    if (!raced) throw new Error('could not create user');
    return { user: (await getUser(db, raced.user_id))!, created: false };
  }
}

/** /r/{code} stores a signed "code:clickedAt" cookie; it is read once when a new account is created. */
export async function setReferralCookie(c: C, code: string, nowMs = Date.now()) {
  setCookie(c, REF_COOKIE, await sign(c.env.SESSION_SECRET, `${code}:${nowMs}`), { path: '/', httpOnly: true, secure: secure(c), sameSite: 'Lax', maxAge: 30 * 86400 });
}

export async function readReferralCookie(c: C): Promise<{ code: string; clickedAtMs: number } | null> {
  const raw = getCookie(c, REF_COOKIE);
  if (!raw) return null;
  const v = await unsign(c.env.SESSION_SECRET, raw);
  if (!v) return null;
  const [code, ts] = v.split(':');
  return code && Number(ts) ? { code, clickedAtMs: Number(ts) } : null;
}

export const clearReferralCookie = (c: C) => deleteCookie(c, REF_COOKIE, { path: '/' });
