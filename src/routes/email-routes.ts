// Web routes for email preferences: the /account form and the one-click unsubscribe link.
import type { Context, Hono } from 'hono';
import type { Session, UserRow } from '../auth/session';
import { DEFAULT_SWITCHES, findPreferencesByToken, getPreferences, isEmailGroup, savePreferences, unsubscribeByToken } from '../email/email-preferences';
import { EMAIL_GROUPS } from '../email/email-message-types';
import type { Env } from '../env';
import { safeEqual } from '../lib/crypto';
import type { AccountEmailView } from '../views/account-email-preferences-section';
import { unsubscribeConfirmPage, unsubscribeDonePage, type UnsubscribeScope } from '../views/email-unsubscribe';
import { errorPage } from '../views/error';
import type { LayoutContext } from '../views/types';

type C = Context<{ Bindings: Env }>;

export interface PageHelpers {
  viewer: (c: C) => Promise<{ session: Session | null; user: UserRow | null }>;
  page: (c: C, title: string, render: (ctx: LayoutContext) => string, status?: number) => Promise<Response>;
}

/** Email part of the account page. Read-only: a user without a preferences row has every group on. */
export async function accountEmailView(db: D1Database, user: UserRow, csrf: string, saved: boolean): Promise<AccountEmailView> {
  const prefs = (await getPreferences(db, user.id)) ?? DEFAULT_SWITCHES;
  return { address: user.email?.trim() || null, products: prefs.products, boards: prefs.boards, referrals: prefs.referrals, csrf, saved };
}

const INVALID_LINK = 'This unsubscribe link is not valid. Manage your email preferences from your account page.';

/** The token is the only credential. Unknown token and malformed scope get the same answer. */
async function resolveUnsubscribe(c: C): Promise<{ token: string; scope: UnsubscribeScope } | null> {
  const token = c.req.query('t') ?? '';
  const g = c.req.query('g') ?? '';
  const scope = g === 'all' || isEmailGroup(g) ? (g as UnsubscribeScope) : null;
  if (!scope) return null;
  return (await findPreferencesByToken(c.env.DB, token)) ? { token, scope } : null;
}

export function registerEmailRoutes(app: Hono<{ Bindings: Env }>, h: PageHelpers) {
  const invalid = (c: C) => h.page(c, 'Unsubscribe — bip.ad', ctx => errorPage(ctx, 404, INVALID_LINK), 404);

  app.post('/account/email', async c => {
    const { session, user } = await h.viewer(c);
    const form = await c.req.parseBody();
    if (!session || !user || typeof form.csrf !== 'string' || !safeEqual(form.csrf, session.csrf)) {
      return h.page(c, 'Forbidden', ctx => errorPage(ctx, 403, 'Your session expired. Sign in again and retry.'), 403);
    }
    // Unchecked boxes are absent from the form: absent means off.
    await savePreferences(c.env.DB, user.id, { products: form.products === '1', boards: form.boards === '1', referrals: form.referrals === '1' });
    return c.redirect('/account?email=saved#email', 303);
  });

  // GET never changes state: mail scanners follow links. It shows a button that POSTs to the same URL.
  app.get('/email/unsubscribe', async c => {
    const r = await resolveUnsubscribe(c);
    if (!r) return invalid(c);
    const action = `/email/unsubscribe?t=${encodeURIComponent(r.token)}&g=${r.scope}`;
    return h.page(c, 'Unsubscribe — bip.ad', ctx => unsubscribeConfirmPage(ctx, r.scope, action));
  });

  // RFC 8058 one-click (body "List-Unsubscribe=One-Click") and the confirmation button. No session or CSRF: the token is the credential.
  app.post('/email/unsubscribe', async c => {
    const r = await resolveUnsubscribe(c);
    if (!r || !(await unsubscribeByToken(c.env.DB, r.token, r.scope === 'all' ? EMAIL_GROUPS : [r.scope]))) return invalid(c);
    return h.page(c, 'Unsubscribed — bip.ad', ctx => unsubscribeDonePage(ctx, r.scope));
  });
}
