import { beforeAll, describe, expect, it } from 'vitest';
import { upsertUser } from '../src/auth/session';
import { refund } from '../src/domain/bidding';
import { outboxStatement } from '../src/domain/ledger';
import { createProduct, moderateProduct, setBlocks, submitProduct } from '../src/domain/products';
import { attributeSignup, getOrCreateReferralCode } from '../src/domain/referrals';
import { freezeBoard, runLock } from '../src/domain/snapshot';
import { piiKeys, preparePayoutBatch, recordManualTransfer, requestPayout, vestCommissions } from '../src/domain/wallet';
import { savePreferences } from '../src/email/email-preferences';
import { emailProjectionBacklog } from '../src/email/email-projection-state';
import { newId } from '../src/lib/ids';
import { cutoffAtOrBefore, DAY_MS, iso } from '../src/lib/time';
import { bid, cfg, db, E, makeProduct, makeUser, realCfg } from './helpers';
import { dataOf, emailsOf, projectAll, projectFromTheBeginning } from './email-helpers';

const slugOf = async (productId: string) => (await db().prepare('SELECT slug FROM products WHERE id = ?').bind(productId).first<{ slug: string }>())!.slug;
const capIdOf = async (intentId: string) => (await db().prepare('SELECT provider_payment_id AS c FROM payments WHERE bid_intent_id = ?').bind(intentId).first<{ c: string }>())!.c;

beforeAll(projectFromTheBeginning);

describe('email projection: one email per trigger', () => {
  it('welcome: a new account (upsertUser) queues one welcome email and a preferences row', async () => {
    const { user, created } = await upsertUser(db(), { provider: 'github', providerUserId: newId('gh'), displayName: 'Newcomer', avatarUrl: null, email: 'new@example.test' });
    expect(created).toBe(true);
    await projectAll();
    const [w, ...rest] = await emailsOf(user.id);
    expect(rest).toEqual([]);
    expect(w).toMatchObject({ kind: 'welcome', group_name: null, dedupe_key: `welcome:${user.id}`, to_address: 'new@example.test', status: 'pending' });
    expect(dataOf(w)).toEqual({ kind: 'welcome', displayName: 'Newcomer' });
    const prefs = await db().prepare('SELECT products, boards, referrals, unsubscribe_token FROM email_preferences WHERE user_id = ?').bind(user.id).first<{ unsubscribe_token: string }>();
    expect(prefs).toMatchObject({ products: 1, boards: 1, referrals: 1 });
    expect(prefs!.unsubscribe_token.length).toBeGreaterThanOrEqual(32);
  });

  it('product_decision: auto-approval, operator rejection of live changes, suspension, rejection of a new product', async () => {
    const u = await makeUser('Maker');
    const p = await makeProduct(u, 'Decided');
    await moderateProduct(db(), 'operator:test', p, 'reject', 'LOW_QUALITY_EDIT');
    await moderateProduct(db(), 'operator:test', p, 'suspend', 'SPAM');
    const draft = await createProduct(db(), u, { name: 'Plain Http', tagline: 'not https', website_url: 'http://example.com' }, newId('k'));
    await setBlocks(db(), u, draft.id, [{ type: 'hero', headline: 'x' }]);
    expect((await submitProduct(db(), cfg(), u, draft.id)).status).toBe('pending_review');
    await moderateProduct(db(), 'operator:test', draft.id, 'reject', 'NON_HTTPS');
    await projectAll();
    const rows = await emailsOf(u, 'product_decision');
    const outcomes = rows.map(r => dataOf<{ outcome: string; reason: string; productName: string }>(r));
    expect(outcomes.map(o => [o.productName, o.outcome, o.reason])).toEqual([
      ['Decided', 'published', ''],
      ['Decided', 'changes_rejected', 'LOW_QUALITY_EDIT'],
      ['Decided', 'suspended', 'SPAM'],
      ['Plain Http', 'rejected', 'NON_HTTPS'],
    ]);
    expect(rows.every(r => r.group_name === 'products' && r.status === 'pending' && r.dedupe_key.startsWith('evt:'))).toBe(true);
    expect(dataOf(rows[0]).productUrl).toBe(`https://bip.test/p/${await slugOf(p)}`);
  });

  it('bid_receipt and bid_reversed: settlement then refund of the same payment', async () => {
    const u = await makeUser('Bidder');
    const p = await makeProduct(u, 'Receipted');
    const intent = await bid(u, p, 'weekly', 2500, Date.now() - 60_000);
    expect((await refund(db(), { provider: 'paypal', providerPaymentId: await capIdOf(intent), kind: 'refund', atMs: Date.now() })).status).toBe('refunded');
    await projectAll();
    const [receipt] = await emailsOf(u, 'bid_receipt');
    expect(receipt.group_name).toBeNull();
    expect(dataOf(receipt)).toMatchObject({
      kind: 'bid_receipt', displayName: 'Bidder', productName: 'Receipted', board: 'weekly', rankUnits: 2500, provider: 'paypal',
      cash: { currency: 'USD', minor: 2500 }, wallet: { currency: 'USD', minor: 0 }, test: false, bidIntentId: intent,
    });
    const [reversed] = await emailsOf(u, 'bid_reversed');
    expect(dataOf(reversed)).toMatchObject({ kind: 'bid_reversed', reversal: 'refund', amount: { currency: 'USD', minor: 2500 }, board: 'weekly', bidIntentId: intent });
  });

  it('lock_results: one email per owner per cutoff across all boards, only products with a counted bid', async () => {
    const cutoff = cutoffAtOrBefore(Date.now());
    const a = await makeUser('Owner A');
    const b = await makeUser('Owner B');
    const free = await makeUser('Free Rider');
    const pa = await makeProduct(a, 'Locked A');
    const pb = await makeProduct(b, 'Locked B');
    await makeProduct(free, 'Never Paid');
    await bid(a, pa, 'daily', 3000, cutoff - 3600_000);
    await bid(a, pa, 'monthly', 1000, cutoff - 7200_000);
    await bid(b, pb, 'weekly', 500, cutoff - 3600_000);
    await runLock(db(), 'https://bip.test', cutoff, Date.now());
    await projectAll();
    const [ea, ...moreA] = await emailsOf(a, 'lock_results');
    expect(moreA).toEqual([]);
    expect(ea).toMatchObject({ group_name: 'boards', dedupe_key: `lock:${iso(cutoff)}:${a}` });
    const data = dataOf<{ cutoffAt: string; nextCutoffAt: string; entries: { board: string; rank: number; rankUnits: number; productName: string; boardSize: number }[] }>(ea);
    expect(data.cutoffAt).toBe(iso(cutoff));
    expect(data.nextCutoffAt).toBe(iso(cutoff + DAY_MS));
    expect(data.entries.map(e => [e.board, e.productName, e.rankUnits])).toEqual([['daily', 'Locked A', 3000], ['monthly', 'Locked A', 1000]]);
    expect(data.entries.every(e => e.rank >= 1 && e.boardSize >= e.rank)).toBe(true);
    expect((await emailsOf(b, 'lock_results')).map(r => dataOf<{ entries: { board: string }[] }>(r).entries.map(e => e.board))).toEqual([['weekly']]);
    expect(await emailsOf(free, 'lock_results')).toEqual([]);
  });

  it('lock_results waits until every board of the cutoff froze, without holding up other emails', async () => {
    const cutoff = cutoffAtOrBefore(Date.now()) - DAY_MS;
    const u = await makeUser('Patient');
    const p = await makeProduct(u, 'Partial Lock');
    await bid(u, p, 'daily', 700, cutoff - 3600_000);
    // Frozen a minute after the cutoff, like the nightly lock (a much later freeze is a back-fill).
    await freezeBoard(db(), 'daily', cutoff, cutoff + 60_000);
    const other = await makeUser('Unblocked');
    await makeProduct(other, 'Later Event');
    await projectAll();
    expect(await emailsOf(u, 'lock_results')).toEqual([]);
    expect(await emailsOf(other, 'product_decision')).toHaveLength(1);
    await freezeBoard(db(), 'weekly', cutoff, cutoff + 120_000);
    await freezeBoard(db(), 'monthly', cutoff, cutoff + 180_000);
    await projectAll();
    expect(await emailsOf(u, 'lock_results')).toHaveLength(1);
  });

  it('lock_results of a cutoff too old to lock again is built from the snapshots that exist', async () => {
    const cutoff = cutoffAtOrBefore(Date.now()) - 5 * DAY_MS;
    const u = await makeUser('Late');
    const p = await makeProduct(u, 'Old Lock', cutoff - 40 * DAY_MS);
    await bid(u, p, 'daily', 900, cutoff - 3600_000);
    await freezeBoard(db(), 'daily', cutoff, cutoff + 3600_000);
    await projectAll();
    const rows = await emailsOf(u, 'lock_results');
    expect(rows.map(r => dataOf<{ entries: { board: string }[] }>(r).entries.map(e => e.board))).toEqual([['daily']]);
  });

  it('commission_available goes to the referrer when the commission vests', async () => {
    const r = await makeUser('Referrer');
    const buyer = await makeUser('Buyer');
    expect(await attributeSignup(db(), cfg(), buyer, await getOrCreateReferralCode(db(), r), Date.now() - 1000)).toBe('attributed');
    const p = await makeProduct(buyer, 'Referred Product');
    const t = Date.now();
    await bid(buyer, p, 'daily', 10000, t);
    await vestCommissions(db(), t + 31 * DAY_MS);
    await projectAll();
    const [c] = await emailsOf(r, 'commission_available');
    expect(c.group_name).toBe('referrals');
    expect(dataOf(c)).toEqual({ kind: 'commission_available', displayName: 'Referrer', amount: { currency: 'USD', minor: 500 }, walletUrl: 'https://bip.test/account/wallet' });
  });

  it('payout_paid when the operator records the manual transfer', async () => {
    const r = await makeUser('Payee');
    const buyer = await makeUser('Payer');
    await attributeSignup(db(), cfg(), buyer, await getOrCreateReferralCode(db(), r), Date.now() - 1000);
    await bid(buyer, await makeProduct(buyer, `Fund ${newId('f')}`), 'monthly', 10000, Date.now() - 40 * DAY_MS);
    await vestCommissions(db(), Date.now());
    const req = await requestPayout(db(), realCfg(), piiKeys(E), r, { currency: 'USD', amountMinor: 500, payoutMethod: 'paypal', beneficiaryReference: 'payee@paypal.test', idempotencyKey: newId('p') }) as { id: string };
    const inWindow = Date.parse('2031-05-04T05:00:00Z');
    await preparePayoutBatch(db(), piiKeys(E), 'operator:test', '2031-05', inWindow);
    await recordManualTransfer(db(), 'operator:test', { payoutRequestId: req.id, bankTransferReference: `FT${req.id}`, amountMinor: 500, transferredAt: iso(inWindow - 3600_000), proofRef: 'vault://p' }, inWindow);
    await projectAll();
    const [paid] = await emailsOf(r, 'payout_paid');
    expect(dataOf(paid)).toMatchObject({ kind: 'payout_paid', amount: { currency: 'USD', minor: 500 }, method: 'paypal', reference: `FT${req.id}` });
  });
});

describe('email projection: idempotence and eligibility', () => {
  it('replaying events (receipts lost, cursor reset) creates no second email', async () => {
    const u = await makeUser('Replay');
    await makeProduct(u, 'Replayed');
    await projectAll();
    const before = await emailsOf(u);
    expect(before).toHaveLength(1);
    await db().batch([
      db().prepare('DELETE FROM email_event_receipts'),
      db().prepare(`UPDATE email_settings SET value = '0' WHERE key = 'projection_cursor'`),
    ]);
    await projectAll();
    await projectAll();
    expect(await emailsOf(u)).toEqual(before);
  });

  it('events created before projection_start are acknowledged but never emailed', async () => {
    const u = await makeUser('Old Timer');
    await outboxStatement(db(), 'UserCreated', u, {}, iso(Date.now() - 60_000)).run();
    await db().prepare(`UPDATE email_settings SET value = ? WHERE key = 'projection_start'`).bind(iso(Date.now() - 1000)).run();
    try {
      await projectAll();
    } finally {
      await projectFromTheBeginning();
    }
    expect(await emailsOf(u)).toEqual([]);
    const receipts = await db().prepare(`SELECT COUNT(*) AS n FROM email_event_receipts r JOIN outbox_events e ON e.id = r.event_id WHERE e.aggregate_id = ?`).bind(u).first<{ n: number }>();
    expect(receipts!.n).toBe(1);
  });

  it('a user without email is skipped (no_email); an opted-out group is skipped (opted_out), mandatory ones are not', async () => {
    const none = await makeUser('No Mail');
    await db().prepare('UPDATE users SET email = NULL WHERE id = ?').bind(none).run();
    await makeProduct(none, 'Silent');
    const out = await makeUser('Opted Out');
    await savePreferences(db(), out, { products: false, boards: true, referrals: true });
    const p = await makeProduct(out, 'Quiet');
    await bid(out, p, 'daily', 1000, Date.now() - 60_000);
    await projectAll();
    expect((await emailsOf(none)).map(r => [r.status, r.skip_reason, r.to_address])).toEqual([['skipped', 'no_email', null]]);
    const rows = await emailsOf(out);
    expect(rows.map(r => [r.kind, r.status, r.skip_reason])).toEqual([['product_decision', 'skipped', 'opted_out'], ['bid_receipt', 'pending', null]]);
  });
});

describe('email projection backlog (operator.health)', () => {
  it('counts domain events the projector has not handled, and drops back once they are projected', async () => {
    await projectAll();
    const before = await emailProjectionBacklog(db());
    await upsertUser(db(), { provider: 'github', providerUserId: newId('gh'), displayName: 'Backlog', avatarUrl: null, email: 'backlog@example.test' });
    expect((await emailProjectionBacklog(db())).unhandled).toBe(before.unhandled + 1);
    await projectAll();
    expect(await emailProjectionBacklog(db())).toEqual(before);
  });
});
