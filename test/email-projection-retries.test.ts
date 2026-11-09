import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { outboxStatement } from '../src/domain/ledger';
import { freezeBoard } from '../src/domain/snapshot';
import {
  acquireProjectionLease, DEFER_RETRY_MS, FAILURE_RETRY_MS, hasProjectionWorkSql, MAX_EVENT_FAILURES, PROJECTION_LEASE_MS, releaseProjectionLease,
} from '../src/email/email-projection-state';
import { projectEmailEvents } from '../src/email/email-projector';
import { processEmails } from '../src/email/process-emails';
import { cutoffAtOrBefore, DAY_MS, iso } from '../src/lib/time';
import { bid, db, E, makeProduct, makeUser } from './helpers';
import { emailsOf, fakeTransport, ORIGIN, projectAll, projectFromTheBeginning } from './email-helpers';

beforeAll(projectFromTheBeginning);
afterEach(() => vi.restoreAllMocks());

const probe = async (nowMs: number) => (await db().prepare(`SELECT ${hasProjectionWorkSql()} AS busy`).bind(iso(nowMs)).first<{ busy: number }>())!.busy === 1;
const deferralOf = (eventId: string) => db().prepare('SELECT retry_after, failures, last_error FROM email_event_deferrals WHERE event_id = ?').bind(eventId)
  .first<{ retry_after: string; failures: number; last_error: string | null }>();
const hasReceipt = async (eventId: string) => !!(await db().prepare('SELECT 1 AS x FROM email_event_receipts WHERE event_id = ?').bind(eventId).first());
const setting = async (key: string) => Number((await db().prepare('SELECT value FROM email_settings WHERE key = ?').bind(key).first<{ value: string }>())!.value);

/** A UserCreated event for a fresh user; returns its id and rowid. */
async function userCreatedEvent(name: string) {
  const u = await makeUser(name);
  await outboxStatement(db(), 'UserCreated', u, {}, iso(Date.now())).run();
  return (await db().prepare(`SELECT id, rowid AS seq FROM outbox_events WHERE aggregate_id = ? AND event_type = 'UserCreated'`).bind(u).first<{ id: string; seq: number }>())!;
}

async function snapshotEvents(cutoffMs: number) {
  const { results } = await db().prepare(`SELECT e.id FROM outbox_events e JOIN board_snapshots s ON s.id = e.aggregate_id
      WHERE e.event_type = 'BoardSnapshotFrozen' AND s.cutoff_at = ?`).bind(iso(cutoffMs)).all<{ id: string }>();
  return results.map(r => r.id);
}

describe('email projection retries', () => {
  it('a snapshot frozen more than 24h after its cutoff (back-fill) is acknowledged without a lock_results email', async () => {
    const cutoff = cutoffAtOrBefore(Date.now()) - 2 * DAY_MS;
    const u = await makeUser('Backfilled');
    await bid(u, await makeProduct(u, 'Backfill Product'), 'daily', 800, cutoff - 3600_000);
    for (const board of ['daily', 'weekly', 'monthly'] as const) await freezeBoard(db(), board, cutoff, Date.now());
    await projectAll();
    expect(await emailsOf(u, 'lock_results')).toEqual([]);
    const events = await snapshotEvents(cutoff);
    expect(events).toHaveLength(3);
    for (const id of events) expect(await hasReceipt(id)).toBe(true);
  });

  it('a deferred lock event is not pending work until its retry_after, then is looked at again', async () => {
    const cutoff = cutoffAtOrBefore(Date.now()) - DAY_MS;
    const u = await makeUser('Waiting');
    await bid(u, await makeProduct(u, 'Waiting Product'), 'daily', 600, cutoff - 3600_000);
    await freezeBoard(db(), 'daily', cutoff, cutoff + 60_000);
    const t = Date.now();
    await projectAll(t);
    const [eventId] = await snapshotEvents(cutoff);
    expect(await deferralOf(eventId)).toMatchObject({ retry_after: iso(t + DEFER_RETRY_MS), failures: 0 });
    expect(await probe(t)).toBe(false);
    expect(await probe(t + DEFER_RETRY_MS)).toBe(true);
    const later = t + DEFER_RETRY_MS;
    const r = await projectEmailEvents(db(), ORIGIN, later);
    expect(r).toMatchObject({ events: 1, deferred: 1 });
    expect((await deferralOf(eventId))!.retry_after).toBe(iso(later + DEFER_RETRY_MS));
    // The other boards freeze: the next look builds the email and clears the deferral.
    await freezeBoard(db(), 'weekly', cutoff, cutoff + 120_000);
    await freezeBoard(db(), 'monthly', cutoff, cutoff + 180_000);
    await projectAll(later + DEFER_RETRY_MS);
    expect(await emailsOf(u, 'lock_results')).toHaveLength(1);
    expect(await deferralOf(eventId)).toBeNull();
    expect(await hasReceipt(eventId)).toBe(true);
  });

  it(`a mapping that keeps failing is retried, then acknowledged without email after ${MAX_EVENT_FAILURES} failures`, async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await projectAll();
    const u = await makeUser('Unmappable');
    await outboxStatement(db(), 'CommissionAvailable', 'rc_missing', {}, iso(Date.now())).run();
    const { id } = (await db().prepare(`SELECT id FROM outbox_events WHERE aggregate_id = 'rc_missing'`).first<{ id: string }>())!;
    const later = await userCreatedEvent('Not Blocked');
    // The commission mapping reads referral_commissions; without the table every attempt throws.
    await db().prepare('ALTER TABLE referral_commissions RENAME TO referral_commissions_away').run();
    try {
      let t = Date.now();
      for (let i = 1; i < MAX_EVENT_FAILURES; i++) {
        expect(await projectEmailEvents(db(), ORIGIN, t)).toMatchObject({ failed: 1, abandoned: 0 });
        expect(await deferralOf(id)).toMatchObject({ retry_after: iso(t + FAILURE_RETRY_MS), failures: i });
        expect(await hasReceipt(id)).toBe(false);
        // Not retried before its retry_after.
        expect((await projectEmailEvents(db(), ORIGIN, t + FAILURE_RETRY_MS - 1)).failed).toBe(0);
        t += FAILURE_RETRY_MS;
      }
      expect(await projectEmailEvents(db(), ORIGIN, t)).toMatchObject({ failed: 1, abandoned: 1 });
    } finally {
      await db().prepare('ALTER TABLE referral_commissions_away RENAME TO referral_commissions').run();
    }
    expect(await hasReceipt(id)).toBe(true);
    expect(await deferralOf(id)).toBeNull();
    expect(errors.mock.calls.some(c => String(c[0]).includes('abandoned'))).toBe(true);
    // The event after it was handled on the first pass, and the cursor now passes both.
    expect(await hasReceipt(later.id)).toBe(true);
    expect(await setting('projection_cursor')).toBeGreaterThanOrEqual(later.seq);
    expect(await emailsOf(u)).toEqual([]);
  });

  it('a later page of the same run starts after the highest rowid seen; the cursor stays below the deferred event', async () => {
    await projectAll();
    const cutoff = cutoffAtOrBefore(Date.now());
    const u = await makeUser('Paged');
    await bid(u, await makeProduct(u, 'Paged Product'), 'daily', 500, cutoff - 3600_000);
    await projectAll();
    await freezeBoard(db(), 'daily', cutoff, cutoff + 60_000);
    const [lockEvent] = await snapshotEvents(cutoff);
    const lockSeq = (await db().prepare('SELECT rowid AS seq FROM outbox_events WHERE id = ?').bind(lockEvent).first<{ seq: number }>())!.seq;
    const next = await userCreatedEvent('Next Page');
    const t = Date.now();
    const first = await projectEmailEvents(db(), ORIGIN, t, { pageSize: 1 });
    expect(first).toMatchObject({ events: 1, deferred: 1, lastSeq: lockSeq });
    const second = await projectEmailEvents(db(), ORIGIN, t, { pageSize: 1, afterSeq: first.lastSeq });
    expect(second).toMatchObject({ events: 1, deferred: 0, lastSeq: next.seq });
    expect(await hasReceipt(next.id)).toBe(true);
    expect(await setting('projection_cursor')).toBe(lockSeq - 1);
    expect(await setting('projection_high')).toBe(next.seq);
    expect(await probe(t)).toBe(false);
  });

  it('only one run projects at a time: a held lease makes processEmails skip projection until it expires', async () => {
    await projectAll();
    const t = Date.now();
    const until = (await acquireProjectionLease(db(), t))!;
    expect(until).toBe(iso(t + PROJECTION_LEASE_MS));
    try {
      expect(await acquireProjectionLease(db(), t + 1000)).toBeNull();
      const e = await userCreatedEvent('Leased');
      const r = await processEmails(E, t + 1000, fakeTransport().transport);
      expect(r).toMatchObject({ projectionSkipped: true, projection: null });
      expect(await hasReceipt(e.id)).toBe(false);
      // An expired lease (crashed run) is taken over.
      const taken = await processEmails(E, t + PROJECTION_LEASE_MS, fakeTransport().transport);
      expect(taken.projectionSkipped).toBe(false);
      expect(await hasReceipt(e.id)).toBe(true);
    } finally {
      await releaseProjectionLease(db(), until);
    }
    // A finished run gives the lease back.
    const again = await acquireProjectionLease(db(), Date.now());
    expect(again).not.toBeNull();
    await releaseProjectionLease(db(), again!);
  });
});
