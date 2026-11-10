// Operator resolution of payment reviews under races, crashes and partial refunds, plus the
// moderation status of page drafts that never went live.
import { describe, expect, it } from 'vitest';
import { beginCheckout, getIntent, quote, resolvePaymentReview } from '../src/domain/bidding';
import { config } from '../src/domain/config';
import { guardStatement } from '../src/domain/ledger';
import { createProduct, moderateProduct, setBlocks } from '../src/domain/products';
import { loadStandings } from '../src/domain/ranking';
import { newId } from '../src/lib/ids';
import { iso } from '../src/lib/time';
import { normalizePayPal, processEvent } from '../src/payments/process';
import { E, cfg, db, ledgerBalancedEverywhere, makeProduct, makeUser } from './helpers';

const sandbox = () => ({ ...config(E), paymentMode: 'sandbox' as const });
const STALE = 11 * 60_000;

const capture = (intentId: string, captureId: string, value: string) => normalizePayPal({
  id: newId('WH'), event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: captureId, status: 'COMPLETED', custom_id: intentId, amount: { currency_code: 'USD', value } },
});
const refundEvent = (captureId: string, value?: string) => normalizePayPal({
  id: newId('WH'), event_type: 'PAYMENT.CAPTURE.REFUNDED',
  resource: { id: newId('REF'), ...(value ? { amount: { currency_code: 'USD', value } } : {}), links: [{ rel: 'up', href: `https://api.paypal.com/v2/payments/captures/${captureId}` }] },
});
const units = async (p: string) => (await loadStandings(db(), 'weekly', Date.now() + 1000)).find(r => r.productId === p)?.activeRankUnits ?? 0;
const reviewStatus = async (id: string) => (await db().prepare('SELECT status FROM payment_reviews WHERE id = ?').bind(id).first<{ status: string }>())!.status;
const decisions = async (reviewId: string, decision: 'allow' | 'deny') =>
  (await db().prepare(`SELECT COUNT(*) AS n FROM decision_logs WHERE action = 'payments.resolve_review' AND resource_id = ? AND decision = ?`).bind(reviewId, decision).first<{ n: number }>())!.n;
const payments = async (intentId: string) => (await db().prepare('SELECT COUNT(*) AS n FROM payments WHERE bid_intent_id = ?').bind(intentId).first<{ n: number }>())!.n;
const claimAt = (id: string, atMs: number) =>
  db().prepare(`UPDATE payment_reviews SET status = 'settled', resolution = 'claimed', resolved_at = ? WHERE id = ?`).bind(iso(atMs), id).run();

/** A full-amount capture of a cancelled intent, held for review; the intent waits in needs_review. */
async function heldCapture(tag: string) {
  const u = await makeUser();
  const p = await makeProduct(u, `Review ${newId('x')}`);
  const { intent } = await quote(db(), cfg(), u, { productId: p, board: 'weekly', rankUnits: 1500, currency: 'USD', idempotencyKey: newId('q') });
  await beginCheckout(db(), cfg(), u, intent.id, 'paypal');
  await db().prepare(`UPDATE bid_intents SET status = 'cancelled' WHERE id = ?`).bind(intent.id).run();
  const capId = `CAP-${tag}-${intent.id}`;
  expect((await processEvent(db(), sandbox(), capture(intent.id, capId, '15.00'))).status).toBe('review:intent_cancelled');
  await db().prepare(`UPDATE bid_intents SET status = 'needs_review' WHERE id = ?`).bind(intent.id).run();
  const rv = await db().prepare('SELECT id FROM payment_reviews WHERE provider_payment_id = ?').bind(capId).first<{ id: string }>();
  return { p, intentId: intent.id, capId, reviewId: rv!.id };
}

/** D1 binding that runs `before` right before its first batch: "read, then a concurrent change, then the write". */
function beforeFirstBatch(before: () => Promise<unknown>): D1Database {
  const real = db();
  let fired = false;
  return new Proxy(real, {
    get(target, key) {
      if (key === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (!fired) { fired = true; await before(); }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** D1 binding whose isolate "dies" right after its first committed batch: every later call fails. */
function crashAfterFirstBatch(): D1Database {
  const real = db();
  let crashed = false;
  const dead = () => { throw new Error('isolate terminated'); };
  return new Proxy(real, {
    get(target, key) {
      if (key === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (crashed) dead();
          const r = await target.batch(statements);
          crashed = true;
          return r;
        };
      }
      if (key === 'prepare') return (sql: string) => (crashed ? dead() : target.prepare(sql));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('changes() inside a D1 batch', () => {
  it('reports the rows changed by the statement right before it, so a guard can depend on one UPDATE', async () => {
    const id = await makeUser('Changes');
    const rename = (who: string, name: string) => db().prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(name, who);
    await expect(db().batch([rename('usr_missing', 'x'), guardStatement(db(), 'changes() = 1')])).rejects.toThrow(/batch_guards/);
    await db().batch([rename(id, 'Renamed'), guardStatement(db(), 'changes() = 1')]);
    // Not a running total of the batch: a matching UPDATE followed by a non-matching one fails, and rolls back.
    await expect(db().batch([rename(id, 'Again'), rename('usr_missing', 'y'), guardStatement(db(), 'changes() = 1')])).rejects.toThrow(/batch_guards/);
    expect((await db().prepare('SELECT display_name FROM users WHERE id = ?').bind(id).first<{ display_name: string }>())!.display_name).toBe('Renamed');
  });
});

describe('payment review resolution', () => {
  it('two identical dismisses racing in the same millisecond log one decision', async () => {
    const { reviewId } = await heldCapture('DISMISS2');
    const t = Date.now();
    const dismiss = (d: D1Database) => resolvePaymentReview(d, sandbox(), 'system:provider', reviewId, 'dismiss', 'refund by provider', t);
    // The second request read the review as open; the first one commits before its batch runs.
    await dismiss(beforeFirstBatch(() => dismiss(db())));
    expect(await reviewStatus(reviewId)).toBe('dismissed');
    expect(await decisions(reviewId, 'deny')).toBe(1);
  });

  it('dismissing a sibling keeps the intent alive while another capture review is claimed for settlement', async () => {
    const { p, intentId, reviewId: claimed } = await heldCapture('SIBCLAIM');
    expect((await processEvent(db(), sandbox(), capture(intentId, `CAP-SIB-${intentId}`, '2.00'))).status).toBe('review:intent_needs_review');
    const sibling = (await db().prepare('SELECT id FROM payment_reviews WHERE provider_payment_id = ?').bind(`CAP-SIB-${intentId}`).first<{ id: string }>())!.id;
    // A dead claim: no payment yet, and the operator can still resume it.
    await claimAt(claimed, Date.now() - STALE);
    expect((await resolvePaymentReview(db(), sandbox(), 'operator:test', sibling, 'dismiss', 'refunded at PayPal')).status).toBe('dismissed');
    expect((await getIntent(db(), intentId))!.status).toBe('needs_review');
    expect((await resolvePaymentReview(db(), sandbox(), 'operator:test', claimed, 'settle', 'resume')).status).toBe('settled');
    expect(await units(p)).toBe(1500);
    expect(await ledgerBalancedEverywhere()).toBe(true);
  });

  it('a sibling capture review recorded after the dismiss read its siblings still keeps the intent alive', async () => {
    const { intentId, reviewId } = await heldCapture('SIBRACE');
    const late = beforeFirstBatch(() => processEvent(db(), sandbox(), capture(intentId, `CAP-SIBR-${intentId}`, '2.00')));
    expect((await resolvePaymentReview(late, sandbox(), 'operator:test', reviewId, 'dismiss', 'refunded')).status).toBe('dismissed');
    expect(await db().prepare(`SELECT 1 FROM payment_reviews WHERE provider_payment_id = ? AND status = 'open'`).bind(`CAP-SIBR-${intentId}`).first()).not.toBeNull();
    expect((await getIntent(db(), intentId))!.status).toBe('needs_review');
  });

  it('a settle that finds the review claimed by another request does not report success', async () => {
    const { intentId, reviewId } = await heldCapture('BUSY');
    await claimAt(reviewId, Date.now());
    expect(await resolvePaymentReview(db(), sandbox(), 'operator:test', reviewId, 'settle', 'second')).toEqual({ review_id: reviewId, status: 'settling' });
    expect(await payments(intentId)).toBe(0);
    expect(await decisions(reviewId, 'allow')).toBe(0);
  });

  it('two concurrent settles of one review: one settlement, one decision, one success', async () => {
    const { intentId, reviewId } = await heldCapture('SETTLE2');
    const results = await Promise.all([1, 2].map(() => resolvePaymentReview(db(), sandbox(), 'operator:test', reviewId, 'settle', 'customer confirmed')));
    expect(results.filter(r => r.settlement).length).toBe(1);
    expect(await payments(intentId)).toBe(1);
    expect(await decisions(reviewId, 'allow')).toBe(1);
    expect(await ledgerBalancedEverywhere()).toBe(true);
  });

  it('a settlement and its allow decision commit together, even if the request dies right after', async () => {
    const { intentId, reviewId } = await heldCapture('CRASH');
    expect((await resolvePaymentReview(crashAfterFirstBatch(), sandbox(), 'operator:test', reviewId, 'settle', 'customer confirmed')).status).toBe('settled');
    expect(await payments(intentId)).toBe(1);
    expect(await decisions(reviewId, 'allow')).toBe(1);
  });

  it('a slow settle cannot commit after a provider refund took over its stale claim', async () => {
    const { p, intentId, capId, reviewId } = await heldCapture('SLOW');
    // The refund lands 11 minutes after the claim, right before the slow request's settlement batch.
    const slow = beforeFirstBatch(async () => {
      expect((await processEvent(db(), sandbox(), refundEvent(capId), Date.now() + STALE)).status).toBe('reviewed_capture_reversed');
    });
    await expect(resolvePaymentReview(slow, sandbox(), 'operator:test', reviewId, 'settle', 'slow')).rejects.toMatchObject({ code: 'not_settleable' });
    expect(await payments(intentId)).toBe(0);
    expect(await reviewStatus(reviewId)).toBe('dismissed');
    expect(await decisions(reviewId, 'allow')).toBe(0);
    expect(await units(p)).toBe(0);
    expect(await ledgerBalancedEverywhere()).toBe(true);
  });
});

describe('a held capture with a partial refund', () => {
  it('cannot be settled: the review is dismissed, the intent fails, and the rest of the refund still closes cleanly', async () => {
    const { p, intentId, capId, reviewId } = await heldCapture('PARTSETTLE');
    expect((await processEvent(db(), sandbox(), refundEvent(capId, '5.00'))).status).toBe('partial_review');
    await expect(resolvePaymentReview(db(), sandbox(), 'operator:test', reviewId, 'settle', 'customer confirmed'))
      .rejects.toMatchObject({ code: 'not_settleable', message: expect.stringMatching(/^partially_refunded:/) });
    expect(await reviewStatus(reviewId)).toBe('dismissed');
    expect((await getIntent(db(), intentId))!.status).toBe('failed');
    expect(await payments(intentId)).toBe(0);
    expect(await decisions(reviewId, 'deny')).toBe(1);
    expect(await units(p)).toBe(0);
    expect((await processEvent(db(), sandbox(), refundEvent(capId, '10.00'))).status).toBe('reviewed_capture_reversed');
    const open = await db().prepare(`SELECT COUNT(*) AS n FROM payment_reviews WHERE provider_payment_id = ? AND status = 'open'`).bind(capId).first<{ n: number }>();
    expect(open!.n).toBe(0);
    expect(await ledgerBalancedEverywhere()).toBe(true);
  });

  it('arriving while the settlement runs refuses it the same way', async () => {
    const { intentId, capId, reviewId } = await heldCapture('PARTRACE');
    const racing = beforeFirstBatch(async () => {
      expect((await processEvent(db(), sandbox(), refundEvent(capId, '5.00'))).status).toBe('partial_review');
    });
    await expect(resolvePaymentReview(racing, sandbox(), 'operator:test', reviewId, 'settle', 'customer confirmed'))
      .rejects.toMatchObject({ code: 'not_settleable', message: expect.stringMatching(/^partially_refunded:/) });
    expect(await payments(intentId)).toBe(0);
    expect(await reviewStatus(reviewId)).toBe('dismissed');
    expect((await getIntent(db(), intentId))!.status).toBe('failed');
    expect(await ledgerBalancedEverywhere()).toBe(true);
  });
});

describe('page moderation', () => {
  it('approving a pending page never marks a draft that did not go live as approved', async () => {
    const u = await makeUser();
    const p = await createProduct(db(), u, { name: 'Drafts', tagline: 'Drafts tagline', website_url: 'https://example.com' }, newId('k'));
    const pending = await setBlocks(db(), u, p.id, [{ type: 'hero', headline: 'Reviewed page' }]);
    const later = await setBlocks(db(), u, p.id, [{ type: 'hero', headline: 'Later draft' }]);
    if (!pending.ok || !later.ok) throw new Error('setBlocks failed');
    // Submitted for review with a page held for moderation and nothing live yet.
    await db().prepare(`UPDATE products SET status = 'pending_review', current_page_version_id = NULL, pending_page_version_id = ? WHERE id = ?`).bind(pending.pageVersionId, p.id).run();
    const v = (await db().prepare('SELECT version FROM products WHERE id = ?').bind(p.id).first<{ version: number }>())!.version;
    const approved = await moderateProduct(db(), 'operator:test', p.id, 'approve', 'OK', Date.now(), v);
    expect(approved.current_page_version_id).toBe(pending.pageVersionId);
    const page = (id: string) => db().prepare('SELECT moderation_status, published_at FROM product_page_versions WHERE id = ?').bind(id)
      .first<{ moderation_status: string; published_at: string | null }>();
    expect(await page(pending.pageVersionId)).toMatchObject({ moderation_status: 'approved' });
    expect(await page(later.pageVersionId)).toEqual({ moderation_status: 'draft', published_at: null });
  });
});
