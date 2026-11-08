// GitHub and Google OAuth (authorization code flow) used for both web sign-in and MCP grants.
import type { Env } from '../env';

export type UpstreamProvider = 'github' | 'google';

export interface UpstreamIdentity {
  provider: UpstreamProvider;
  providerUserId: string;
  displayName: string;
  avatarUrl: string | null;
  email: string | null;
}

export const callbackUrl = (origin: string, p: UpstreamProvider) => `${origin}/auth/${p}/callback`;

export function authorizeUrl(env: Env, origin: string, p: UpstreamProvider, state: string) {
  if (p === 'github') {
    const u = new URL('https://github.com/login/oauth/authorize');
    u.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: callbackUrl(origin, p), scope: 'read:user user:email', state, allow_signup: 'true' }).toString();
    return u.toString();
  }
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: callbackUrl(origin, p), response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' }).toString();
  return u.toString();
}

export async function exchange(env: Env, origin: string, p: UpstreamProvider, code: string, fetcher: typeof fetch = fetch): Promise<UpstreamIdentity> {
  if (p === 'github') {
    const t = await fetcher('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: callbackUrl(origin, p) }),
    });
    const tok = (await t.json()) as { access_token?: string; error?: string };
    if (!tok.access_token) throw new Error(`github token: ${tok.error ?? t.status}`);
    const h = { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'bip-ad' };
    const u = (await (await fetcher('https://api.github.com/user', { headers: h })).json()) as { id: number; login: string; name?: string; avatar_url?: string };
    let email: string | null = null;
    const er = await fetcher('https://api.github.com/user/emails', { headers: h });
    if (er.ok) email = ((await er.json()) as { email: string; primary: boolean; verified: boolean }[]).find(e => e.primary && e.verified)?.email ?? null;
    return { provider: p, providerUserId: String(u.id), displayName: u.name || u.login, avatarUrl: u.avatar_url ?? null, email };
  }
  const t = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: callbackUrl(origin, p) }),
  });
  const tok = (await t.json()) as { access_token?: string; error?: string };
  if (!tok.access_token) throw new Error(`google token: ${tok.error ?? t.status}`);
  const u = (await (await fetcher('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } })).json()) as {
    sub: string; name?: string; picture?: string; email?: string; email_verified?: boolean;
  };
  return { provider: p, providerUserId: u.sub, displayName: u.name || (u.email?.split('@')[0] ?? 'Builder'), avatarUrl: u.picture ?? null, email: u.email_verified ? u.email ?? null : null };
}
