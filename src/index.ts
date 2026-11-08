import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { app } from './app';
import { expireIntents } from './domain/bidding';
import { config } from './domain/config';
import { runDueLocks } from './domain/snapshot';
import { vestCommissions } from './domain/wallet';
import type { Env, McpProps } from './env';
import { serveMcp } from './mcp/common';
import { userMcpServer } from './mcp/user-server';

/** /mcp: reached only with a valid OAuth access token; the provider puts the grant props on ctx.props. */
const mcpApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: McpProps }) {
    const userId = ctx.props?.userId;
    if (!userId) return new Response('unauthorized', { status: 401 });
    const user = await env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(userId).first<{ status: string }>();
    if (!user || user.status !== 'active') return new Response('account suspended', { status: 403 });
    return serveMcp(userMcpServer(env, userId), request);
  },
};

let provider: OAuthProvider<Env> | null = null;
let providerOrigin = '';

/** Built lazily because the protected-resource metadata needs the configured public origin. */
function oauthProvider(env: Env) {
  const origin = config(env).origin;
  if (!provider || providerOrigin !== origin) {
    providerOrigin = origin;
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpApi as never,
      defaultHandler: app as never,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      scopesSupported: SCOPES,
      accessTokenTTL: 3600,
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: 'BIP.AD user MCP' },
    });
  }
  return provider;
}

const SCOPES = ['bip.products', 'bip.boosts', 'bip.wallet'];

/** Housekeeping, then the 03:12 ICT lock (and catch-up of any missed cutoff). */
export async function scheduledJob(env: Env, nowMs = Date.now()) {
  await vestCommissions(env.DB, nowMs);
  await expireIntents(env.DB, nowMs);
  return runDueLocks(env.DB, config(env).origin, nowMs);
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => oauthProvider(env).fetch(req, env, ctx),
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(scheduledJob(env).then(r => console.log('lock run', JSON.stringify(r.map(x => ({ cutoff: x.cutoffAt, skipped: x.skipped }))))));
  },
} satisfies ExportedHandler<Env>;
