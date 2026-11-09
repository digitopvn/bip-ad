import { describe, expect, it, vi } from 'vitest';
import wranglerConfig from '../wrangler.jsonc?raw';
import { outboxStatement } from '../src/domain/ledger';
import { QueryBudget, QueryBudgetExhausted, meteredDb } from '../src/email/d1-query-meter';
import { sendDueEmails } from '../src/email/email-sender';
import { IN_CHUNK, recipientCache } from '../src/email/email-recipient-cache';
import { CRON_RUN, processEmails, projectUnderLease, REQUEST_RUN } from '../src/email/process-emails';
import { EMAIL_CRON, runScheduled } from '../src/index';
import { iso } from '../src/lib/time';
import { db, E, makeUser } from './helpers';
import { fakeTransport, ORIGIN, projectAll, projectFromTheBeginning, queue, row } from './email-helpers';

const FROM = 'noreply@bip.ad';
const receipted = async (eventId: string) => !!(await db().prepare('SELECT 1 AS x FROM email_event_receipts WHERE event_id = ?').bind(eventId).first());
const lockRuns = async () => (await db().prepare(`SELECT COUNT(*) AS n FROM job_runs WHERE job_type = 'daily_lock'`).first<{ n: number }>())!.n;

describe('email cron', () => {
  it('runs in its own cron invocation, declared in wrangler.jsonc, and the lock crons no longer send email', async () => {
    expect(wranglerConfig).toContain(`"${EMAIL_CRON}"`);
    expect(CRON_RUN.queryCap).toBeLessThanOrEqual(800);
    const u = await makeUser('Cron Mail');
    // Due a minute ago, at real time: both crons run at Date.now().
    const id = await queue(u, 'welcome', Date.now() - 60_000);
    const locksBefore = await lockRuns();
    await runScheduled('40 * * * *', E);
    expect((await row(id)).status).toBe('pending');
    await runScheduled(EMAIL_CRON, E);
    expect((await row(id)).status).toBe('sent');
    // The email cron does not lock; the hourly one does (or catches up).
    const afterEmail = await lockRuns();
    await runScheduled(EMAIL_CRON, E);
    expect(await lockRuns()).toBe(afterEmail);
    expect(afterEmail).toBeGreaterThanOrEqual(locksBefore);
  });
});

describe('request run deadline', () => {
  it('a run past its deadline sends nothing and leaves the rows pending', async () => {
    const t = Date.parse('2034-01-01T00:00:00Z');
    const u = await makeUser('Too Late');
    const ids = [await queue(u, 'welcome', t), await queue(u, 'welcome', t)];
    const fake = fakeTransport();
    const r = await processEmails(E, t, fake.transport, REQUEST_RUN, { deadlineMs: Date.now() - 1 });
    expect(r).toMatchObject({ sending: null, projection: null });
    expect(await sendDueEmails(db(), fake.transport, { origin: ORIGIN, from: FROM, nowMs: t, deadlineMs: Date.now() + 4_000 })).toMatchObject({ claimed: 0 });
    expect(fake.sent).toEqual([]);
    for (const id of ids) expect(await row(id)).toMatchObject({ status: 'pending', attempts: 0 });
    for (const id of ids) await db().prepare('DELETE FROM email_outbox WHERE id = ?').bind(id).run();
  });

  it('hands claimed rows back unsent when the deadline comes too close mid-batch', async () => {
    const t = Date.parse('2034-02-01T00:00:00Z');
    const u = await makeUser('Slow Provider');
    const ids = [await queue(u, 'welcome', t), await queue(u, 'welcome', t), await queue(u, 'welcome', t)];
    // A fake wall clock: each send takes 2 s, the deadline leaves 1 s above the 5 s margin.
    let clock = 0;
    const fake = fakeTransport();
    const slow = { send: async (m: Parameters<typeof fake.transport.send>[0]) => ((clock += 2_000), fake.transport.send(m)) };
    const r = await sendDueEmails(db(), slow, { origin: ORIGIN, from: FROM, nowMs: t, deadlineMs: 6_000, clock: () => clock });
    expect(r).toMatchObject({ claimed: 3, sent: 1, released: 2 });
    const rows = await Promise.all(ids.map(row));
    expect(rows.filter(x => x.status === 'pending' && x.attempts === 0 && x.next_attempt_at === iso(t))).toHaveLength(2);
    for (const id of ids) await db().prepare('DELETE FROM email_outbox WHERE id = ?').bind(id).run();
  });

  it('hands the claimed rows back when loading preferences fails after the claim', async () => {
    const t = Date.parse('2034-03-01T00:00:00Z');
    const u = await makeUser('No Prefs Table');
    const ids = [await queue(u, 'welcome', t), await queue(u, 'welcome', t)];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await db().prepare('ALTER TABLE email_preferences RENAME TO email_preferences_away').run();
    try {
      expect(await sendDueEmails(db(), fakeTransport().transport, { origin: ORIGIN, from: FROM, nowMs: t })).toMatchObject({ claimed: 2, sent: 0, released: 2 });
    } finally {
      await db().prepare('ALTER TABLE email_preferences_away RENAME TO email_preferences').run();
      errors.mockRestore();
    }
    for (const id of ids) expect(await row(id)).toMatchObject({ status: 'pending', attempts: 0 });
    for (const id of ids) await db().prepare('DELETE FROM email_outbox WHERE id = ?').bind(id).run();
  });

  it('a cron run claims at the current time of each round and stops at its 8-minute deadline', async () => {
    const t = Date.parse('2034-04-01T00:00:00Z');
    const u = await makeUser('Long Cron');
    const ids = await Promise.all(Array.from({ length: CRON_RUN.sendLimit + 1 }, () => queue(u, 'welcome', t)));
    // A fake wall clock: each send takes 10 s, so the second round starts more than 250 s into the run.
    let clock = 0;
    const fake = fakeTransport();
    const slow = { send: async (m: Parameters<typeof fake.transport.send>[0]) => ((clock += 10_000), fake.transport.send(m)) };
    const r = await processEmails(E, t, slow, CRON_RUN, { clock: () => clock });
    expect(r.sending).toMatchObject({ claimed: ids.length, sent: ids.length, released: 0 });
    // The last row was claimed in round two, stamped with nowMs moved on by the elapsed wall time.
    const last = (await Promise.all(ids.map(row))).sort((x, y) => x.updated_at.localeCompare(y.updated_at)).at(-1)!;
    expect(Date.parse(last.updated_at)).toBe(t + CRON_RUN.sendLimit * 10_000);
    // Past the deadline nothing new starts: a fresh due row stays pending.
    const late = await queue(u, 'welcome', t);
    let jumps = 0;
    const r2 = await processEmails(E, t, slow, CRON_RUN, { clock: () => (jumps++ === 0 ? 0 : CRON_RUN.windowMs) });
    expect(r2.sending).toMatchObject({ claimed: 0 });
    expect(await row(late)).toMatchObject({ status: 'pending', attempts: 0 });
    for (const id of [...ids, late]) await db().prepare('DELETE FROM email_outbox WHERE id = ?').bind(id).run();
  });
});

describe('projection lease and budget', () => {
  it('a run that caught up projects events written before it releases the lease', async () => {
    await projectFromTheBeginning();
    await projectAll();
    const u = await makeUser('Raced');
    let pages = 0;
    const r = await projectUnderLease(db(), ORIGIN, Date.now(), {
      budget: new QueryBudget(150), rounds: 1,
      // The event is committed after the first page was read, while this run still holds the lease.
      onPage: async () => {
        if (pages++ === 0) await outboxStatement(db(), 'UserCreated', u, {}, iso(Date.now())).run();
      },
    });
    expect(r.skipped).toBe(false);
    expect(pages).toBe(2);
    const { id } = (await db().prepare(`SELECT id FROM outbox_events WHERE aggregate_id = ?`).bind(u).first<{ id: string }>())!;
    expect(await receipted(id)).toBe(true);
  });

  it('display names are loaded per chunk only while the budget allows the chunk and the final batch', async () => {
    const budget = new QueryBudget(3);
    const cache = recipientCache(meteredDb(db(), budget), budget);
    const ids = Array.from({ length: IN_CHUNK * 2 + 1 }, (_, i) => `usr_none_${i}`);
    await expect(cache.load(ids)).rejects.toBeInstanceOf(QueryBudgetExhausted);
    expect(budget.used).toBe(2);
  });
});
