import { describe, expect, it } from 'vitest';
import type { EmailMessageData, EmailRenderContext } from '../src/email/email-message-types';
import { renderEmail } from '../src/email/email-templates';

const grouped: EmailRenderContext = { origin: 'https://bip.ad', unsubscribeUrl: 'https://bip.ad/unsub/abc', preferencesUrl: 'https://bip.ad/account', subjectPrefix: '[staging] ' };
const mandatory: EmailRenderContext = { ...grouped, unsubscribeUrl: null };
const EVIL = '<script>alert(1)</script>"';
const money = { currency: 'USD', minor: 1200 };
const base = { displayName: 'Ann', productName: 'Acme', productUrl: 'https://bip.ad/p/acme' };

const receipt = (over: Partial<Extract<EmailMessageData, { kind: 'bid_receipt' }>> = {}): EmailMessageData => ({
  kind: 'bid_receipt', ...base, board: 'daily', rankUnits: 1200, cash: money, wallet: { currency: 'USD', minor: 0 },
  provider: 'paypal', test: false, bidIntentId: 'bi_1', confirmedAt: '2026-11-08T20:00:00Z', ...over,
});

const all: EmailMessageData[] = [
  { kind: 'welcome', displayName: 'Ann' },
  ...(['published', 'rejected', 'changes_rejected', 'suspended'] as const).map((outcome): EmailMessageData => ({ kind: 'product_decision', ...base, outcome, reason: 'Too vague' })),
  receipt(),
  { kind: 'bid_reversed', ...base, board: 'weekly', reversal: 'refund', amount: money, bidIntentId: 'bi_1' },
  { kind: 'lock_results', displayName: 'Ann', cutoffAt: '2026-11-08T20:12:00Z', nextCutoffAt: '2026-11-09T20:12:00Z', boardsUrl: 'https://bip.ad/', entries: [{ productName: 'Acme', productUrl: 'https://bip.ad/p/acme', board: 'daily', rank: 2, boardSize: 10, rankUnits: 1200 }] },
  { kind: 'commission_available', displayName: 'Ann', amount: money, walletUrl: 'https://bip.ad/wallet' },
  { kind: 'payout_paid', displayName: 'Ann', amount: money, method: 'PayPal', reference: 'ref1', walletUrl: 'https://bip.ad/wallet' },
];

const lockData = all.find((d) => d.kind === 'lock_results') as EmailMessageData;

describe('email templates', () => {
  it.each(all.map((d) => [d.kind + (d.kind === 'product_decision' ? `:${d.outcome}` : ''), d] as const))('renders %s', (_n, data) => {
    const out = renderEmail(data, grouped);
    expect(out.subject.startsWith('[staging] ')).toBe(true);
    expect(out.subject.length).toBeGreaterThan(12);
    expect(out.html).toContain('href="https://');
    expect(out.text.length).toBeGreaterThan(40);
    expect(out.text).toContain('https://');
  });

  it('uses concrete subjects', () => {
    expect(renderEmail(receipt(), mandatory).subject).toBe('[staging] Your bid on Acme is confirmed: $12.00 on Daily');
    expect(renderEmail(all[1], mandatory).subject).toBe('[staging] Acme is live on bip.ad');
    expect(renderEmail(lockData, mandatory).subject).toBe('[staging] Lock results for Nov 9: Acme is #2 on Daily');
  });

  it('escapes hostile user data in html but keeps text readable', () => {
    for (const d of all) {
      const evil = { ...d, displayName: EVIL, ...('productName' in d ? { productName: EVIL } : {}), ...('reason' in d ? { reason: EVIL } : {}) } as EmailMessageData;
      const out = renderEmail(evil, grouped);
      expect(out.html).not.toContain('<script>');
      if ('productName' in d) expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;');
    }
    const lock = { ...lockData, entries: [{ productName: EVIL, productUrl: 'https://bip.ad/p/x', board: 'daily', rank: 1, boardSize: 3, rankUnits: 5 }] } as EmailMessageData;
    expect(renderEmail(lock, grouped).html).not.toContain('<script>');
  });

  it('never emits non-http(s) links as href', () => {
    const bad = renderEmail(receipt({ productUrl: 'javascript:alert(1)' }), grouped);
    expect(bad.html).not.toMatch(/javascript:/i);
    expect(bad.text).not.toMatch(/javascript:/i);
    const quote = renderEmail(receipt({ productUrl: 'https://x.test/"onmouseover="alert(1)' }), grouped);
    expect(quote.html).not.toContain('"onmouseover');
  });

  it('flags test payments only when test', () => {
    expect(renderEmail(receipt({ test: true }), mandatory).html).toContain('Test payment — no money moved');
    expect(renderEmail(receipt({ test: true }), mandatory).text).toContain('Test payment — no money moved');
    expect(renderEmail(receipt(), mandatory).html).not.toContain('Test payment');
  });

  it('shows the all-pay rule and receipt facts', () => {
    const out = renderEmail(receipt(), mandatory);
    expect(out.text).toContain('not refunded');
    expect(out.text).toContain('bi_1');
    expect(out.text).toContain('2026-11-09 03:00 ICT');
  });

  it('includes the unsubscribe link only for grouped emails', () => {
    const g = renderEmail(all[1], grouped);
    expect(g.html).toContain('https://bip.ad/unsub/abc');
    expect(g.text).toContain('https://bip.ad/unsub/abc');
    expect(g.html).toContain('Manage email preferences');
    const m = renderEmail(receipt(), mandatory);
    expect(m.html).not.toContain('unsub');
    expect(m.text).not.toContain('Unsubscribe');
    expect(m.html).toContain('https://bip.ad/account');
    expect(m.text).toContain('transactional notice');
  });

  it('welcome points at the MCP endpoint and rejection mentions MCP tools', () => {
    expect(renderEmail(all[0], mandatory).text).toContain('https://bip.ad/mcp');
    expect(renderEmail(all[2], grouped).text).toContain('products.submit');
  });
});
