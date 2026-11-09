// Entry point of transactional email: project new domain events, then send due emails.
// Runs from the cron and, right after mutating requests, from waitUntil. It never throws: a failed
// step is logged and retried by the next run.
import { config } from '../domain/config';
import type { Env } from '../env';
import { iso } from '../lib/time';
import { meteredDb, QueryBudget } from './d1-query-meter';
import { acquireProjectionLease, hasProjectionWorkSql, releaseProjectionLease } from './email-projection-state';
import { PROJECTION_PAGE_SIZE, type ProjectionResult, projectEmailEvents } from './email-projector';
import { hasDueEmailsSql, SEND_LEASE_MS, type SendResult, sendDueEmails } from './email-sender';
import { bindingTransport, type EmailTransport, parseFromAddress } from './email-transport';

/** How much one run may do. D1 allows 1000 queries per invocation (a batch counts as one). */
export interface RunProfile {
  /** Projection pages and send batches per run. */
  rounds: number;
  /** Emails per send batch. */
  sendLimit: number;
  /** Queries this run may issue; the invocation that scheduled it keeps the rest. */
  queryCap: number;
}

/** After a request (waitUntil): one page and a few emails; bulk work is left to the cron. */
export const REQUEST_RUN: RunProfile = { rounds: 1, sendLimit: 5, queryCap: 150 };
/** Cron: drains a large lock run while staying well under the 1000-query limit. */
export const CRON_RUN: RunProfile = { rounds: 8, sendLimit: 25, queryCap: 600 };

export interface ProcessEmailsResult {
  idle: boolean;
  /** Another run held the projection lease (or taking it failed), so this run only sent. */
  projectionSkipped: boolean;
  projection: ProjectionResult | null;
  sending: SendResult | null;
  queriesUsed: number;
}

/** Add up per-page counters; `lastSeq` and flags take the latest page's value. */
function sum<T extends object>(a: T, b: T): T {
  const r = { ...a } as Record<string, unknown>;
  for (const [k, v] of Object.entries(b)) r[k] = typeof v === 'number' && k !== 'lastSeq' ? ((r[k] as number) ?? 0) + v : v;
  return r as T;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.error(`email ${name} failed`, e);
    return null;
  }
}

/** One indexed probe: is there an event to (re)project or a due email? */
async function hasWork(db: D1Database, nowMs: number) {
  const r = await db.prepare(`SELECT ${hasProjectionWorkSql()} OR ${hasDueEmailsSql()} AS busy`)
    .bind(iso(nowMs), iso(nowMs - SEND_LEASE_MS)).first<{ busy: number }>();
  return r?.busy === 1;
}

async function project(env: Env, origin: string, nowMs: number, budget: QueryBudget, profile: RunProfile, out: ProcessEmailsResult) {
  const db = meteredDb(env.DB, budget);
  const lease = await step('projection lease', () => acquireProjectionLease(db, nowMs));
  if (lease === null) {
    out.projectionSkipped = true;
    return;
  }
  let afterSeq: number | undefined;
  for (let i = 0; i < profile.rounds; i++) {
    const r = await step('projection', () => projectEmailEvents(env.DB, origin, nowMs, { budget, afterSeq }));
    if (!r) break;
    out.projection = out.projection ? sum(out.projection, r) : r;
    if (r.budgetExhausted || r.events < PROJECTION_PAGE_SIZE) break;
    // Deferred events stay below the cursor; the next page starts past everything this run saw.
    afterSeq = r.lastSeq;
  }
  await step('projection lease release', () => releaseProjectionLease(db, lease));
}

/**
 * One bounded run. `nowMs` is the instant used for due checks and timestamps; callers pass the
 * current time (the default), never a stale job-start time.
 */
export async function processEmails(env: Env, nowMs = Date.now(), transport?: EmailTransport, profile: RunProfile = REQUEST_RUN): Promise<ProcessEmailsResult> {
  const budget = new QueryBudget(profile.queryCap);
  const out: ProcessEmailsResult = { idle: false, projectionSkipped: false, projection: null, sending: null, queriesUsed: 0 };
  const done = () => ({ ...out, queriesUsed: budget.used });
  const busy = await step('probe', () => hasWork(meteredDb(env.DB, budget), nowMs));
  if (busy === false) {
    out.idle = true;
    return done();
  }
  const origin = await step('config', async () => config(env).origin);
  if (!origin) return done();
  await project(env, origin, nowMs, budget, profile, out);

  const t = transport ?? (env.EMAIL ? bindingTransport(env.EMAIL) : null);
  const from = parseFromAddress(env.EMAIL_FROM);
  if (!t) console.warn('email: the EMAIL binding is not configured; queued emails stay pending');
  else if (!from) console.warn('email: EMAIL_FROM is missing or not an address; queued emails stay pending');
  else {
    const replyTo = env.EMAIL_REPLY_TO?.trim() || undefined;
    for (let i = 0; i < profile.rounds; i++) {
      const r = await step('sending', () => sendDueEmails(env.DB, t, { origin, from, replyTo, nowMs, limit: profile.sendLimit, budget }));
      if (!r) break;
      out.sending = out.sending ? sum(out.sending, r) : r;
      if (r.claimed < profile.sendLimit) break;
    }
  }
  return done();
}

/** Schedule a short run after the response without delaying or failing the request. */
export function scheduleEmailProcessing(env: Env, waitUntil: (p: Promise<unknown>) => void) {
  try {
    waitUntil(processEmails(env));
  } catch (e) {
    console.error('email: could not schedule processing', e);
  }
}
