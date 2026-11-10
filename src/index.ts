import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { app } from './app';
import { expireIntents } from './domain/bidding';
import { meteredDb, QueryBudget } from './email/d1-query-meter';
import { CRON_RUN, processEmails, scheduleEmailProcessing } from './email/process-emails';
import { config } from './domain/config';
import { refreshMetricRollup } from './domain/ranking';
import { type LockRun, runDueLocks } from './domain/snapshot';
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
 * D1 queries one lock/housekeeping cron invocation may use: the Workers Free limit is 50 per
 * invocation (a db.batch() counts as one), minus headroom for estimates that run short.
 */
export const SCHEDULED_QUERY_CAP = 45;

/**
 * Worst-case queries of the housekeeping steps: fixed reads/writes plus a cost per item, used to
 * size each step's page from the queries left. The moderation job cost is a conservative estimate
 * (claim, both stages, scores, the decision batch and the job status writes).
 */
const HOUSEKEEPING_QUERIES = {
  expire: { fixed: 1, perItem: 3, max: 100 },
  vest: { fixed: 2, perItem: 1, max: 100 },
  moderation: { fixed: 3, perItem: 15, max: 10 },
} as const;

/** Items that fit in what is left of the budget, capped at the step's page size. */
const pageFor = (budget: QueryBudget, step: keyof typeof HOUSEKEEPING_QUERIES) => {
  const q = HOUSEKEEPING_QUERIES[step];
  return Math.max(0, Math.min(q.max, Math.floor((budget.remaining - q.fixed) / q.perItem)));
};

/**
 * One lock/housekeeping cron invocation, within `cap` D1 queries. In priority order:
 * 1. the 03:12 ICT lock and catch-up of missed cutoffs, step by step while the budget allows;
 * 2. the hourly ranking metric rollup the live boards read;
 * 3. housekeeping pages sized to what is left (quote expiry, commission vesting, AI moderation sweep).
 * Every step is idempotent and works oldest-first, so whatever does not fit resumes on the next
 * hourly run. A lock failure is retried by the hourly trigger; housekeeping failures never block the lock.
 */
export async function scheduledJob(env: Env, nowMs = Date.now(), cap = SCHEDULED_QUERY_CAP) {
  const budget = new QueryBudget(cap);
  const db = meteredDb(env.DB, budget);
  const cfg = config(env);
  let locks: LockRun[] = [];
  try {
    locks = await runDueLocks(db, cfg.origin, nowMs, undefined, budget);
  } catch (e) {
    console.error('lock run failed', e);
  }
  if (budget.allows(2)) await isolated('refreshMetricRollup', () => refreshMetricRollup(db, nowMs));
  const expire = pageFor(budget, 'expire');
  if (expire) await isolated('expireIntents', () => expireIntents(db, nowMs, undefined, expire));
  const vest = pageFor(budget, 'vest');
  if (vest) await isolated('vestCommissions', () => vestCommissions(db, nowMs, vest));
  // Fallback for AI moderation jobs that failed or never ran inline (retries, stale runs, missing credentials at the time).
  const moderation = pageFor(budget, 'moderation');
  if (moderation) await isolated('sweepPendingModeration', () => sweepPendingModeration({ ...env, DB: db }, cfg, nowMs, moderation));
  console.log('scheduled queries', budget.used);
  return locks;
}

/** Cron of the email run (wrangler.jsonc triggers). Its own invocation, so it never shares the D1 query limit with the lock. */
export const EMAIL_CRON = '*/15 * * * *';

/** Route a cron invocation: the email cron only processes email; the others run the lock and housekeeping. */
export async function runScheduled(cron: string, env: Env) {
  if (cron === EMAIL_CRON) {
    const r = await processEmails(env, Date.now(), undefined, CRON_RUN);
    console.log('email run', JSON.stringify({ projection: r.projection, sending: r.sending, queries: r.queriesUsed }));
    return r;
  }
  const locks = await scheduledJob(env);
  console.log('lock run', JSON.stringify(locks.map(x => ({ cutoff: x.cutoffAt, skipped: x.skipped, complete: x.complete }))));
  return locks;
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => oauthProvider(env).fetch(req, env, ctx),
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(controller.cron, env));
  },
} satisfies ExportedHandler<Env>;
