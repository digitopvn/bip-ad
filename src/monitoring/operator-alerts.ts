// Operator alerts: the hourly cron detects conditions that need a human and queues one alert per
// condition and period (operator_alerts.dedupe_key); the 15-minute email cron mails them to
// OPERATOR_ALERT_EMAIL through the same Email Service transport as transactional email.
import { openDeadLetterCount } from '../ads/adapter-call-log';
import { type ReconcileResult, reconcileHealthy } from '../ads/ads-safety-controls';
import { RANKING_POLICY_VERSION } from '../domain/config';
import { emailProjectionBacklog } from '../email/email-projection-state';
import { bindingTransport, type EmailTransport, parseFromAddress, subjectPrefixFor } from '../email/email-transport';
import type { Env } from '../env';
import { newId } from '../lib/ids';
import { cutoffAtOrBefore, HOUR_MS, ictDate, iso } from '../lib/time';
import { escapeHtml } from '../views/html';

/** Unhandled domain events or overdue emails at which the email pipeline counts as backed up. */
export const EMAIL_BACKLOG_ALERT_EVENTS = 100;
export const EMAIL_OVERDUE_ALERT = 20;
/** A lock not done this long after its cutoff is missed (the hourly cron retries it twice by then). */
export const LOCK_MISSED_AFTER_MS = 2 * HOUR_MS;
/** Alerts older than this are not mailed late (e.g. once OPERATOR_ALERT_EMAIL is finally set). */
export const ALERT_MAX_AGE_MS = 24 * HOUR_MS;
const MAX_ALERT_ATTEMPTS = 5;

export type AlertKind = 'reconcile_unbalanced' | 'email_backlog' | 'lock_missed' | 'dead_letters_open';

export interface OperatorAlert {
  kind: AlertKind;
  dedupeKey: string;
  title: string;
  detail: Record<string, unknown>;
}

/** Current alert conditions (4 queries plus the reconcile the caller already ran). */
export async function detectAlerts(db: D1Database, reconcile: ReconcileResult, nowMs = Date.now()): Promise<OperatorAlert[]> {
  const day = ictDate(nowMs);
  const alerts: OperatorAlert[] = [];
  if (!reconcileHealthy(reconcile)) {
    alerts.push({ kind: 'reconcile_unbalanced', dedupeKey: `reconcile_unbalanced:${day}`, title: 'Ledger reconciliation is unbalanced; ads are paused',
      detail: { unbalanced_transactions: reconcile.unbalanced?.length ?? null, wallet_drift: reconcile.wallet_drift.length } });
  }
  const backlog = await emailProjectionBacklog(db);
  const overdue = (await db.prepare(`SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'pending' AND next_attempt_at < ?`).bind(iso(nowMs - HOUR_MS)).first<{ n: number }>())?.n ?? 0;
  if (backlog.unhandled >= EMAIL_BACKLOG_ALERT_EVENTS || overdue >= EMAIL_OVERDUE_ALERT) {
    alerts.push({ kind: 'email_backlog', dedupeKey: `email_backlog:${day}`, title: 'Transactional email is backed up', detail: { ...backlog, overdue_emails: overdue } });
  }
  const cutoff = cutoffAtOrBefore(nowMs);
  if (nowMs - cutoff >= LOCK_MISSED_AFTER_MS) {
    const job = await db.prepare(`SELECT status FROM job_runs WHERE job_type = 'daily_lock' AND resource_id = ? AND version = ?`).bind(iso(cutoff), RANKING_POLICY_VERSION).first<{ status: string }>();
    if (job?.status !== 'done') {
      alerts.push({ kind: 'lock_missed', dedupeKey: `lock_missed:${iso(cutoff)}`, title: `The 03:12 lock of ${ictDate(cutoff)} has not finished`, detail: { cutoff_at: iso(cutoff), job_status: job?.status ?? 'not_started' } });
    }
  }
  const dlq = await openDeadLetterCount(db);
  if (dlq > 0) alerts.push({ kind: 'dead_letters_open', dedupeKey: `dead_letters_open:${day}`, title: `${dlq} failed adapter call(s) wait in the dead-letter queue`, detail: { open: dlq } });
  return alerts;
}

/** Queue alerts; a condition already alerted in its period is not queued again. One batch. */
export async function enqueueAlerts(db: D1Database, alerts: OperatorAlert[], nowMs = Date.now()) {
  if (!alerts.length) return;
  const now = iso(nowMs);
  await db.batch(alerts.map(a => db.prepare(`INSERT INTO operator_alerts (id, kind, dedupe_key, detail_json, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)
      ON CONFLICT (dedupe_key) DO NOTHING`).bind(newId('alr'), a.kind, a.dedupeKey, JSON.stringify({ title: a.title, ...a.detail }), now)));
}

interface AlertRow {
  id: string;
  kind: string;
  detail_json: string;
  attempts: number;
  created_at: string;
}

function render(row: AlertRow, origin: string) {
  const detail = JSON.parse(row.detail_json) as Record<string, unknown> & { title?: string };
  const title = String(detail.title ?? row.kind);
  const lines = Object.entries(detail).filter(([k]) => k !== 'title').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  const text = `${title}\n\n${lines.join('\n')}\n\nRaised ${row.created_at}. Runbooks: docs/runbooks/failure-runbooks.md. Check operator.health on ${origin}/operator/mcp.`;
  const html = `<p><strong>${escapeHtml(title)}</strong></p><ul>${lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul><p>Raised ${escapeHtml(row.created_at)}. Runbooks: docs/runbooks/failure-runbooks.md.</p>`;
  return { subject: `${subjectPrefixFor(origin)}[bip.ad alert] ${title}`, text, html };
}

/** Mail pending alerts. Never throws for a single alert: its failure is recorded and retried next run. */
export async function sendOperatorAlerts(env: Env, origin: string, nowMs = Date.now(), transport?: EmailTransport) {
  const db = env.DB;
  const now = iso(nowMs);
  await db.prepare(`UPDATE operator_alerts SET status = 'skipped', last_error = 'stale: not mailed within 24 hours' WHERE status = 'pending' AND created_at < ?`)
    .bind(iso(nowMs - ALERT_MAX_AGE_MS)).run();
  const to = parseFromAddress(env.OPERATOR_ALERT_EMAIL);
  const from = parseFromAddress(env.EMAIL_FROM);
  const t = transport ?? (env.EMAIL ? bindingTransport(env.EMAIL) : null);
  if (typeof to !== 'string' || !from || !t) return { sent: 0, failed: 0, waiting: true };
  const { results } = await db.prepare(`SELECT id, kind, detail_json, attempts, created_at FROM operator_alerts WHERE status = 'pending' ORDER BY created_at LIMIT 10`).all<AlertRow>();
  let sent = 0, failed = 0;
  for (const row of results) {
    try {
      await t.send({ from, to, ...render(row, origin) });
      await db.prepare(`UPDATE operator_alerts SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL WHERE id = ?`).bind(now, row.id).run();
      sent++;
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      await db.prepare(`UPDATE operator_alerts SET attempts = attempts + 1, last_error = ?, status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id = ?`)
        .bind(error, MAX_ALERT_ATTEMPTS, row.id).run();
      failed++;
    }
  }
  return { sent, failed, waiting: false };
}
