// Entry point of transactional email: project new domain events, then send due emails.
// Runs from the cron and, right after mutating requests, from waitUntil. It never throws: a failed
// step is logged and retried by the next run.
import { config } from '../domain/config';
import type { Env } from '../env';
import { iso } from '../lib/time';
import { hasUnprojectedEventsSql, PROJECTION_PAGE_SIZE, type ProjectionResult, projectEmailEvents } from './email-projector';
import { hasDueEmailsSql, SEND_BATCH_SIZE, SEND_LEASE_MS, type SendResult, sendDueEmails } from './email-sender';
import { bindingTransport, type EmailTransport, parseFromAddress } from './email-transport';

export interface ProcessEmailsResult {
  idle: boolean;
  projection: ProjectionResult | null;
  sending: SendResult | null;
}

function sum<T extends object>(a: T, b: T): T {
  const r = { ...a } as Record<string, number>;
  for (const [k, v] of Object.entries(b)) r[k] = (r[k] ?? 0) + (v as number);
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

/** One indexed probe: is there an unprojected event or a due email? */
async function hasWork(db: D1Database, nowMs: number) {
  const r = await db.prepare(`SELECT ${hasUnprojectedEventsSql()} OR ${hasDueEmailsSql()} AS busy`)
    .bind(iso(nowMs), iso(nowMs - SEND_LEASE_MS)).first<{ busy: number }>();
  return r?.busy === 1;
}

/**
 * `rounds` bounds how many projection pages and send batches one call handles: 1 after a request
 * (waitUntil has a short budget), more from the cron so a large lock run drains in one go.
 */
export async function processEmails(env: Env, nowMs = Date.now(), transport?: EmailTransport, rounds = 1): Promise<ProcessEmailsResult> {
  const out: ProcessEmailsResult = { idle: false, projection: null, sending: null };
  const busy = await step('probe', () => hasWork(env.DB, nowMs));
  if (busy === false) return { ...out, idle: true };
  const origin = await step('config', async () => config(env).origin);
  if (!origin) return out;
  for (let i = 0; i < rounds; i++) {
    const r = await step('projection', () => projectEmailEvents(env.DB, origin, nowMs));
    if (!r) break;
    out.projection = out.projection ? sum(out.projection, r) : r;
    if (r.events < PROJECTION_PAGE_SIZE) break;
  }

  const t = transport ?? (env.EMAIL ? bindingTransport(env.EMAIL) : null);
  if (!t) {
    console.warn('email: the EMAIL binding is not configured; queued emails stay pending');
    return out;
  }
  const from = parseFromAddress(env.EMAIL_FROM);
  if (!from) {
    console.warn('email: EMAIL_FROM is missing or not an address; queued emails stay pending');
    return out;
  }
  const replyTo = env.EMAIL_REPLY_TO?.trim() || undefined;
  for (let i = 0; i < rounds; i++) {
    const r = await step('sending', () => sendDueEmails(env.DB, t, { origin, from, replyTo, nowMs }));
    if (!r) break;
    out.sending = out.sending ? sum(out.sending, r) : r;
    if (r.claimed < SEND_BATCH_SIZE) break;
  }
  return out;
}

/** Schedule a run after the response without delaying or failing the request. */
export function scheduleEmailProcessing(env: Env, waitUntil: (p: Promise<unknown>) => void) {
  try {
    waitUntil(processEmails(env));
  } catch (e) {
    console.error('email: could not schedule processing', e);
  }
}
