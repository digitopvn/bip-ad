import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { app } from './app';
import { expireIntents } from './domain/bidding';
import { CRON_RUN, processEmails, scheduleEmailProcessing } from './email/process-emails';
import { config } from './domain/config';
import { runDueLocks } from './domain/snapshot';
import { vestCommissions } from './domain/wallet';
import type { Env, McpProps } from './env';
import { serveMcp } from './mcp/common';
import { userMcpServer } from './mcp/user-server';
import { sweepPendingModeration } from './moderation/ai-moderation-pipeline';

/** /mcp: reached only with a valid OAuth access token; the provider puts the grant props on ctx.props. */
const mcpApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: McpProps }) {
    const userId = ctx.props?.userId;
    if (!userId) return new Response('unauthorized', { status: 401 });
    const user = await env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(userId).first<{ status: string }>();
    if (!user || user.status !== 'active') return new Response('account suspended', { status: 403 });
    const res = await serveMcp(userMcpServer(env, userId, p => ctx.waitUntil(p)), request);
    // Tool calls (products, bids, payouts) may have queued domain events: email them promptly.
    if (request.method === 'POST') scheduleEmailProcessing(env, p => ctx.waitUntil(p));
    return res;
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

/** Run one housekeeping step; its failure is logged and never blocks the lock. */
async function isolated(name: string, fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (e) {
    console.error(`${name} failed`, e);
    return null;
  }
}

/**
 * The 03:12 ICT lock (and catch-up of any missed cutoff) runs first, then housekeeping in pages.
 * A lock failure is retried by the hourly trigger; housekeeping failures never block the lock.
 */
export async function scheduledJob(env: Env, nowMs = Date.now()) {
  let locks: Awaited<ReturnType<typeof runDueLocks>> = [];
  try {
    locks = await runDueLocks(env.DB, config(env).origin, nowMs);
  } catch (e) {
    console.error('lock run failed', e);
  }
  await isolated('vestCommissions', () => vestCommissions(env.DB, nowMs));
  await isolated('expireIntents', () => expireIntents(env.DB, nowMs));
  // Fallback for AI moderation jobs that failed or never ran inline (retries, stale runs, missing credentials at the time).
  await isolated('sweepPendingModeration', () => sweepPendingModeration(env, config(env), nowMs));
  // Transactional email last, so it covers the lock results, vested commissions and moderation decisions above.
  // The current time, not nowMs: the steps above may have taken a while and leases/backoff are wall-clock.
  await isolated('processEmails', () => processEmails(env, Date.now(), undefined, CRON_RUN));
  return locks;
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => oauthProvider(env).fetch(req, env, ctx),
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(scheduledJob(env).then(r => console.log('lock run', JSON.stringify(r.map(x => ({ cutoff: x.cutoffAt, skipped: x.skipped }))))));
  },
} satisfies ExportedHandler<Env>;
