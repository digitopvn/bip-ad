import { describe, expect, it } from 'vitest';
import { savePreferences } from '../src/email/email-preferences';
import { QueryBudget } from '../src/email/d1-query-meter';
import { MAX_SEND_ATTEMPTS, RETRY_BACKOFF_MS, SEND_LEASE_MS, sendDueEmails } from '../src/email/email-sender';
import { parseFromAddress, subjectPrefixFor } from '../src/email/email-transport';
import { processEmails, REQUEST_RUN } from '../src/email/process-emails';
import type { Env } from '../src/env';
import { newId } from '../src/lib/ids';
import { iso } from '../src/lib/time';
import { db, E, makeUser } from './helpers';
import { fakeTransport, ORIGIN, queue, row } from './email-helpers';

const FROM = { name: 'bip.ad', email: 'noreply@bip.ad' };
// Each test sends at its own instant far from the others so rows of earlier tests are never due again.
let clock = Date.parse('2032-01-01T00:00:00Z');
const nextClock = () => (clock += 30 * 86400_000);

const send = (transport: ReturnType<typeof fakeTransport>['transport'], nowMs: number, origin = ORIGIN) => sendDueEmails(db(), transport, { origin, from: FROM, nowMs });

describe('email sender', () => {
  it('sends a due email, records the provider id, and adds one-click unsubscribe headers only to grouped kinds', async () => {
    const t = nextClock();
    const u = await makeUser('Sam');
    const welcome = await queue(u, 'welcome', t);
    const decision = await queue(u, 'product_decision', t);
    const notYet = await queue(u, 'welcome', t + 60_000);
    const fake = fakeTransport();
    const r = await send(fake.transport, t);
    expect(r).toMatchObject({ claimed: 2, sent: 2 });
    expect((await row(notYet)).status).toBe('pending');
    for (const id of [welcome, decision]) {
      const x = await row(id);
      expect(x).toMatchObject({ status: 'sent', attempts: 1, sent_at: iso(t), last_error: null });
      expect(x.provider_message_id).toMatch(/^msg_/);
    }
    const token = (await db().prepare('SELECT unsubscribe_token AS t FROM email_preferences WHERE user_id = ?').bind(u).first<{ t: string }>())!.t;
    const grouped = fake.sent.find(m => m.headers)!;
    expect(grouped.headers).toEqual({ 'List-Unsubscribe': `<${ORIGIN}/email/unsubscribe?t=${token}&g=products>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    expect(fake.sent.filter(m => !m.headers)).toHaveLength(1);
    expect(fake.sent.every(m => m.to === 'sam@example.test' && m.from === FROM && m.subject.startsWith('[staging] '))).toBe(true);
    // Delivered rows are never sent again.
    expect((await send(fake.transport, t + 1000)).claimed).toBe(0);
    await db().prepare('DELETE FROM email_outbox WHERE id = ?').bind(notYet).run();
  });

  it('re-checks preferences before sending: an opt-out after queueing skips the email', async () => {
    const t = nextClock();
    const u = await makeUser('Changed Mind');
    const id = await queue(u, 'product_decision', t);
    await savePreferences(db(), u, { products: false, boards: true, referrals: true });
    const fake = fakeTransport();
    expect(await send(fake.transport, t)).toMatchObject({ claimed: 1, skipped: 1, sent: 0 });
    expect(await row(id)).toMatchObject({ status: 'skipped', skip_reason: 'opted_out' });
    expect(fake.sent).toEqual([]);
  });

  it('retries with backoff 5m, 15m, 1h, 3h, 6h and gives up after 6 failed attempts', async () => {
    let t = nextClock();
    const u = await makeUser('Unlucky');
    const id = await queue(u, 'welcome', t);
    const failing = fakeTransport({ fail: true });
    for (let attempt = 1; attempt < MAX_SEND_ATTEMPTS; attempt++) {
      expect(await send(failing.transport, t)).toMatchObject({ claimed: 1, retried: 1 });
      const x = await row(id);
      expect(x).toMatchObject({ status: 'pending', attempts: attempt, next_attempt_at: iso(t + RETRY_BACKOFF_MS[attempt - 1]) });
      expect(x.last_error).toContain('provider unavailable');
      // Not due before the backoff ends.
      expect((await send(failing.transport, t + RETRY_BACKOFF_MS[attempt - 1] - 1)).claimed).toBe(0);
      t += RETRY_BACKOFF_MS[attempt - 1];
    }
    expect(await send(failing.transport, t)).toMatchObject({ claimed: 1, failed: 1 });
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: MAX_SEND_ATTEMPTS });
    expect((await send(fakeTransport().transport, t + 86400_000)).claimed).toBe(0);
  });

  it('a permanent provider error code fails the row at once and records the code; unknown errors keep retrying', async () => {
    const t = nextClock();
    const u = await makeUser('Bounced');
    const id = await queue(u, 'welcome', t);
    const err = Object.assign(new Error('recipient is on the suppression list'), { code: 'E_RECIPIENT_SUPPRESSED' });
    expect(await send(fakeTransport({ fail: err }).transport, t)).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'E_RECIPIENT_SUPPRESSED: recipient is on the suppression list' });
    const transient = await queue(u, 'welcome', t + 1000);
    const busy = Object.assign(new Error('slow down'), { code: 'E_RATE_LIMIT_EXCEEDED' });
    expect(await send(fakeTransport({ fail: busy }).transport, t + 1000)).toMatchObject({ claimed: 1, retried: 1 });
    expect(await row(transient)).toMatchObject({ status: 'pending', last_error: 'E_RATE_LIMIT_EXCEEDED: slow down' });
    await db().prepare('DELETE FROM email_outbox WHERE id = ?').bind(transient).run();
  });

  it('omits the one-click unsubscribe headers when the origin is not https', async () => {
    const t = nextClock();
    const u = await makeUser('Local Dev');
    await queue(u, 'product_decision', t);
    const fake = fakeTransport();
    expect(await send(fake.transport, t, 'http://localhost:8787')).toMatchObject({ sent: 1 });
    expect(fake.sent[0].headers).toBeUndefined();
    expect(fake.sent[0].text).toContain('http://localhost:8787/email/unsubscribe?t=');
  });

  it('loads preferences for the whole batch in one query and never claims more than the query budget can record', async () => {
    const t = nextClock();
    const users = await Promise.all(['A', 'B', 'C', 'D'].map(n => makeUser(`Budget ${n}`)));
    const ids = await Promise.all(users.map(u => queue(u, 'product_decision', t)));
    const all = new QueryBudget(1000);
    // Claim batch + preferences batch + one outcome write per row: 2 + 2 here regardless of the user count.
    expect(await sendDueEmails(db(), fakeTransport().transport, { origin: ORIGIN, from: FROM, nowMs: t, limit: 2, budget: all })).toMatchObject({ claimed: 2, sent: 2 });
    expect(all.used).toBe(4);
    const tight = new QueryBudget(4);
    expect(await sendDueEmails(db(), fakeTransport().transport, { origin: ORIGIN, from: FROM, nowMs: t, budget: tight })).toMatchObject({ claimed: 1, sent: 1 });
    expect(tight.used).toBe(3);
    expect((await sendDueEmails(db(), fakeTransport().transport, { origin: ORIGIN, from: FROM, nowMs: t, budget: new QueryBudget(3) })).claimed).toBe(0);
    expect((await Promise.all(ids.map(row))).filter(r => r.status === 'sent')).toHaveLength(3);
    // A request-time run sends at most REQUEST_RUN.sendLimit and stays under its query cap.
    await Promise.all(Array.from({ length: REQUEST_RUN.sendLimit + 2 }, () => queue(users[0], 'welcome', t)));
    const r = await processEmails(E, t, fakeTransport().transport);
    expect(r.sending!.sent).toBe(REQUEST_RUN.sendLimit);
    expect(r.queriesUsed).toBeLessThanOrEqual(REQUEST_RUN.queryCap);
    await db().prepare(`DELETE FROM email_outbox WHERE status = 'pending' AND next_attempt_at = ?`).bind(iso(t)).run();
  });

  it('two concurrent runs never send the same email twice', async () => {
    const t = nextClock();
    const u = await makeUser('Racer');
    const ids = await Promise.all([1, 2, 3, 4, 5].map(() => queue(u, 'welcome', t)));
    const fake = fakeTransport({ delayMs: 20 });
    const [a, b] = await Promise.all([send(fake.transport, t), send(fake.transport, t)]);
    expect(a.claimed + b.claimed).toBe(5);
    expect(fake.sent).toHaveLength(5);
    for (const id of ids) expect((await row(id)).status).toBe('sent');
  });

  it('reclaims a row whose sending lease expired, and fails it when that was its last attempt', async () => {
    const t = nextClock();
    const u = await makeUser('Crashed');
    const retry = await queue(u, 'welcome', t - SEND_LEASE_MS - 1, { status: 'sending', attempts: 1 });
    const fresh = await queue(u, 'welcome', t - 1000, { status: 'sending', attempts: 1 });
    const spent = await queue(u, 'welcome', t - SEND_LEASE_MS - 1, { status: 'sending', attempts: MAX_SEND_ATTEMPTS });
    const fake = fakeTransport();
    expect(await send(fake.transport, t)).toMatchObject({ claimed: 1, sent: 1 });
    expect(await row(retry)).toMatchObject({ status: 'sent', attempts: 2 });
    expect((await row(fresh)).status).toBe('sending');
    expect(await row(spent)).toMatchObject({ status: 'failed', last_error: 'send lease expired' });
  });

  it('processEmails projects then sends, is idle when there is nothing to do, and leaves rows pending without a sender address', async () => {
    const t = nextClock();
    const u = await makeUser('End To End');
    await queue(u, 'welcome', t);
    const unconfigured = { ...E, EMAIL_FROM: '' } as Env;
    expect((await processEmails(unconfigured, t, fakeTransport().transport)).sending).toBeNull();
    const fake = fakeTransport();
    const r = await processEmails(E, t, fake.transport);
    // Also delivers rows left 'sending' by the lease test once their lease expired.
    expect(r.sending!.sent).toBeGreaterThanOrEqual(1);
    expect(fake.sent[0].from).toEqual({ name: 'bip.ad', email: 'hello@bip.ad' });
    expect(fake.sent[0].replyTo).toBe('hello@bip.ad');
    expect((await processEmails(E, t, fake.transport)).idle).toBe(true);
  });
});

describe('email transport helpers', () => {
  it('parses EMAIL_FROM and picks the subject prefix from the origin', () => {
    expect(parseFromAddress('bip.ad <noreply@bip.ad>')).toEqual({ name: 'bip.ad', email: 'noreply@bip.ad' });
    expect(parseFromAddress('"BIP AD" <hi@bip.ad>')).toEqual({ name: 'BIP AD', email: 'hi@bip.ad' });
    expect(parseFromAddress('noreply@bip.ad')).toBe('noreply@bip.ad');
    expect(parseFromAddress('<noreply@bip.ad>')).toBe('noreply@bip.ad');
    for (const bad of [undefined, '', 'bip.ad', 'Name <not-an-address>']) expect(parseFromAddress(bad)).toBeNull();
    expect(subjectPrefixFor('https://bip.ad')).toBe('');
    expect(subjectPrefixFor('https://www.bip.ad')).toBe('');
    expect(subjectPrefixFor('https://bip-ad.digitop.workers.dev')).toBe('[staging] ');
    expect(subjectPrefixFor('http://bip.ad')).toBe('[staging] ');
  });
});
