// Entry point of transactional email: project new domain events, then send due emails.
// Runs from its own 15-minute cron and, right after mutating requests, from waitUntil. It never
// throws: a failed step is logged and retried by the next run.
import { config } from '../domain/config';
import type { Env } from '../env';
import { iso } from '../lib/time';
import { meteredDb, QueryBudget } from './d1-query-meter';
import { acquireProjectionLease, hasProjectionWorkSql, hasUnseenEvents, releaseProjectionLease } from './email-projection-state';
import { PROJECTION_PAGE_SIZE, type ProjectionResult, projectEmailEvents } from './email-projector';
import { hasDueEmailsSql, SEND_LEASE_MS, type SendResult, sendDueEmails } from './email-sender';
import { bindingTransport, type EmailTransport, parseFromAddress } from './email-transport';

/** How much one run may do. D1 allows 1000 queries per invocation (a batch counts as one). */
export interface RunProfile {
  /** Projection pages and send batches per run. */
  rounds: number;
  /** Emails per send batch. */
  sendLimit: number;
  /** Queries this run may issue. */
  queryCap: number;
  /** Wall-clock time the run may take when no explicit deadline is given. */
  windowMs: number;
}

/**
 * After a request (waitUntil): one page and a few emails, leaving the request most of the query
 * limit. waitUntil work may be cancelled about 30 s after the response, so it plans for 20 s.
 */
export const REQUEST_RUN: RunProfile = { rounds: 1, sendLimit: 5, queryCap: 150, windowMs: 20_000 };
/**
 * The email cron owns its invocation; 800 leaves headroom under the 1000-query limit. 8 minutes
 * keeps every claim far inside the 10-minute send lease.
 */
export const CRON_RUN: RunProfile = { rounds: 8, sendLimit: 25, queryCap: 800, windowMs: 8 * 60_000 };
/** Extra pages a caught-up run may project for events written while it worked, before releasing the lease. */
const MAX_LEASE_RECHECKS = 2;

/** Deadline of a request run whose waitUntil work starts at `startedAtMs`. */
export const requestRunDeadline = (startedAtMs = Date.now()) => startedAtMs + REQUEST_RUN.windowMs;

export interface RunTiming {
  /** Wall-clock instant when the platform may cancel the run; defaults to start + profile.windowMs. */
  deadlineMs?: number;
  /** Wall clock (injectable for tests). */
  clock?: () => number;
}

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

export interface ProjectionRunOptions {
  budget: QueryBudget;
  rounds: number;
  /** Wall-clock instant after which no new page starts. */
  deadlineMs?: number;
  clock?: () => number;
  /** Called after each page (observability and tests). */
  onPage?: (r: ProjectionResult) => Promise<void>;
}

/**
 * Project up to `rounds` pages under the projection lease; skipped when another run holds it.
 * A run that caught up looks once more for events written meanwhile before giving the lease back,
 * so an event whose own run was skipped because of the lease is not left for the cron.
 */
export async function projectUnderLease(rawDb: D1Database, origin: string, nowMs: number, o: ProjectionRunOptions) {
  const db = meteredDb(rawDb, o.budget);
  const lease = await step('projection lease', () => acquireProjectionLease(db, nowMs));
  if (lease === null) return { skipped: true, projection: null };
  const clock = o.clock ?? Date.now;
  const timeLeft = () => o.deadlineMs === undefined || clock() < o.deadlineMs;
  let projection: ProjectionResult | null = null;
  let afterSeq: number | undefined;
  let pages = 0;
  let rechecks = 0;
  while (timeLeft()) {
    const r = await step('projection', () => projectEmailEvents(rawDb, origin, nowMs, { budget: o.budget, afterSeq }));
    if (!r) break;
    pages++;
    projection = projection ? sum(projection, r) : r;
    await o.onPage?.(r);
    if (r.budgetExhausted) break;
    // The next page starts past everything this run saw; deferred events stay below the cursor.
    afterSeq = r.lastSeq;
    if (r.events === PROJECTION_PAGE_SIZE) {
      if (pages < o.rounds) continue;
      break;
    }
    if (rechecks++ >= MAX_LEASE_RECHECKS || !o.budget.allows(2) || !timeLeft()) break;
    if (!(await step('projection recheck', () => hasUnseenEvents(db)))) break;
  }
  await step('projection lease release', () => releaseProjectionLease(db, lease));
  return { skipped: false, projection };
}

/**
 * One bounded run. `nowMs` is the instant used for due checks and timestamps (callers pass the
 * current time). `deadlineMs` is when the platform may cancel the run: no page or send starts
 * too close to it.
 */
export async function processEmails(env: Env, nowMs = Date.now(), transport?: EmailTransport, profile: RunProfile = REQUEST_RUN, timing: RunTiming = {}): Promise<ProcessEmailsResult> {
  const clock = timing.clock ?? Date.now;
  const startedAt = clock();
  const deadlineMs = timing.deadlineMs ?? startedAt + profile.windowMs;
  // `nowMs` moved on by the wall time spent so far: a long run never stamps a claim that already looks lease-expired.
  const currentNow = () => nowMs + (clock() - startedAt);
  const budget = new QueryBudget(profile.queryCap);
  const out: ProcessEmailsResult = { idle: false, projectionSkipped: false, projection: null, sending: null, queriesUsed: 0 };
  const done = () => ({ ...out, queriesUsed: budget.used });
  if (startedAt >= deadlineMs) return done();
  const busy = await step('probe', () => hasWork(meteredDb(env.DB, budget), nowMs));
  if (busy === false) {
    out.idle = true;
    return done();
  }
  const origin = await step('config', async () => config(env).origin);
  if (!origin) return done();
  const p = await projectUnderLease(env.DB, origin, nowMs, { budget, rounds: profile.rounds, deadlineMs, clock });
  out.projectionSkipped = p.skipped;
  out.projection = p.projection;

  const t = transport ?? (env.EMAIL ? bindingTransport(env.EMAIL) : null);
  const from = parseFromAddress(env.EMAIL_FROM);
  if (!t) console.warn('email: the EMAIL binding is not configured; queued emails stay pending');
  else if (!from) console.warn('email: EMAIL_FROM is missing or not an address; queued emails stay pending');
  else {
    const replyTo = env.EMAIL_REPLY_TO?.trim() || undefined;
    for (let i = 0; i < profile.rounds; i++) {
      const r = await step('sending', () => sendDueEmails(env.DB, t, { origin, from, replyTo, nowMs: currentNow(), limit: profile.sendLimit, budget, deadlineMs, clock }));
      if (!r) break;
      out.sending = out.sending ? sum(out.sending, r) : r;
      if (r.claimed < profile.sendLimit || r.released > 0) break;
    }
  }
  return done();
}

/** Schedule a short run after the response without delaying or failing the request. */
export function scheduleEmailProcessing(env: Env, waitUntil: (p: Promise<unknown>) => void) {
  try {
    waitUntil(processEmails(env, Date.now(), undefined, REQUEST_RUN, { deadlineMs: requestRunDeadline() }));
  } catch (e) {
    console.error('email: could not schedule processing', e);
  }
}
