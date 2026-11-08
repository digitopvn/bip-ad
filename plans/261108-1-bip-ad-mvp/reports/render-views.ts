// Renders every server view with realistic fake view models into HTML files for the browser check.
// Usage: esbuild-bundle this file, then `node bundle.mjs <outDir>`. Also asserts escaping of hostile input.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  accountPage, authorizePage, boardPage, checkoutPage, errorPage, homePage, loginPage, productPage, snapshotPage,
} from '../../../src/views/index';
import type { BoardCode, BoardRow, BoardView, CheckoutView, LayoutContext, ProductPageView } from '../../../src/views/types';

const out = process.argv[2] ?? 'out';
mkdirSync(out, { recursive: true });

const NOW = Date.now();
const ICT = 7 * 3600e3;
function nextLock(now: number): string {
  const t = new Date(now + ICT);
  let target = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 3, 12) - ICT;
  if (target <= now) target += 86400e3;
  return new Date(target).toISOString();
}
const cutoff = nextLock(NOW);

const ctx = (path: string, title: string, signedIn = true): LayoutContext => ({
  title, path, testMode: true, origin: 'http://127.0.0.1:8791',
  viewer: signedIn ? { userId: 'u_1', displayName: 'Linh Tran', avatarUrl: null } : null,
});

const PRODUCTS: [string, string, string][] = [
  ['shipnote', 'Shipnote', 'Changelogs your users actually read'],
  ['formwise', 'Formwise', 'Forms that fill themselves from context'],
  ['tidy-inbox', 'Tidy Inbox', 'Email triage that learns your rules'],
  ['quietly', 'Quietly', 'Focus timer with team presence'],
  ['lumen-notes', 'Lumen Notes', 'Notes that link themselves'],
  ['stackpulse', 'StackPulse', 'Uptime and cost alerts in one feed'],
  ['briefcase', 'Briefcase', 'Client portals in an afternoon'],
  ['pixelmint', 'Pixelmint', 'Screenshot to production UI'],
  ['commitly', 'Commitly', 'Standups written from your commits'],
  ['nookbook', 'Nookbook', 'Booking pages for tiny studios'],
  ['draftboard', 'Draftboard', 'Plan launches on a shared canvas'],
  ['yarnwise', 'Yarnwise', 'Pattern library for knitters'],
  ['pagecraft', 'Pagecraft', 'Landing pages from a prompt'],
  ['ledgerly', 'Ledgerly', 'Bookkeeping for solo founders'],
  ['evil', '<script>alert("x")</script>Evil & Co', 'Tagline with <img src=x onerror=alert(1)> and "quotes"'],
];
const BIDS = [52000, 38850, 36750, 36750, 21000, 15500, 12000, 9900, 7500, 6000, 3000, 2500, 0, 0, 0];

function rows(count: number, paidCount: number): BoardRow[] {
  return PRODUCTS.slice(0, count).map(([slug, name, tagline], i) => ({
    rank: i + 1, productId: `p_${slug}`, slug, name, tagline,
    activeRankUnits: i < paidCount ? (BIDS[i] ?? 0) : 0,
    ownerSuccessfulReferrals: 20 - i, validClicks: 1800 - i * 97, validViews: 9000 - i * 300,
    isSample: slug !== 'evil', imageUrl: slug === 'pixelmint' ? '/img/bip-ad-logo.png' : slug === 'evil' ? 'javascript:alert(1)' : null,
  }));
}
const board = (b: BoardCode, r: BoardRow[]): BoardView => ({ board: b, nextCutoffAt: cutoff, rows: r, rankingPolicyVersion: 'rank-v1' });
const daily = board('daily', rows(15, 12));
const weekly = board('weekly', rows(5, 3));
const monthly = board('monthly', []);

const pages: Record<string, string> = {};
pages['home'] = homePage(ctx('/', 'The board that locks at 3:12', false), {
  boards: { daily, weekly, monthly }, active: 'daily', lastSnapshotDate: { daily: '2026-11-07', weekly: '2026-11-07' }, mcpUrl: 'http://127.0.0.1:8791/mcp',
});
pages['board-daily'] = boardPage(ctx('/daily', 'Daily board'), daily, '2026-11-07');
pages['board-weekly'] = boardPage(ctx('/weekly', 'Weekly board'), weekly);
pages['board-monthly'] = boardPage(ctx('/monthly', 'Monthly board'), monthly);

const product: ProductPageView = {
  productId: 'p_evil', slug: 'evil', name: 'Pixelmint <b>bold</b>', tagline: 'Screenshot to production UI "fast"',
  websiteUrl: 'https://www.pixelmint.example/landing?a=1&b=2', outboundPath: '/go/pixelmint', isSample: true,
  status: 'pending_review', previewVersion: 3, pageVersion: 3,
  standings: [{ board: 'daily', rank: 8, activeRankUnits: 9900 }, { board: 'weekly', rank: null, activeRankUnits: 0 }, { board: 'monthly', rank: 2, activeRankUnits: 120000 }],
  ownerSuccessfulReferrals: 14,
  blocks: [
    { type: 'hero', headline: 'Ship UI from a screenshot', subheadline: 'Drop an image, get accessible components.', image_url: 'http://127.0.0.1:8791/img/bip-ad-logo.png' },
    { type: 'metrics', items: [{ label: 'Components shipped', value: '12,480' }, { label: 'Teams', value: '310' }, { label: 'Median time', value: '41s' }] },
    { type: 'feature_grid', title: 'What you get', features: [{ title: 'Real code', body: 'React, Vue or plain HTML.' }, { title: 'Accessible', body: 'Contrast and focus states checked.' }, { title: '<script>x</script>', body: 'Escaped title.' }] },
    { type: 'rich_text', markdown: '## Why Pixelmint\nWe **hate** pixel pushing. *Really.* Use `npx pixelmint`.\n\n- Fast\n- Safe [docs](https://pixelmint.example/docs)\n- Evil [click](javascript:alert(1))\n\n### Raw HTML is inert\n<img src=x onerror=alert(1)><script>alert(2)</script>\n\n1. One\n2. Two' },
    { type: 'gallery', images: [{ url: 'http://127.0.0.1:8791/img/bip-ad-logo.png', alt: 'Editor view' }, { url: 'javascript:alert(1)', alt: 'dropped' }, { url: 'http://127.0.0.1:8791/img/bip-mark.webp', alt: 'Mark "quoted"' }] },
    { type: 'video', url: 'https://www.youtube.com/watch?v=abc123', title: 'Two-minute demo' },
    { type: 'video', url: 'http://127.0.0.1:8791/img/missing-demo.mp4', title: 'Direct mp4' },
    { type: 'pricing', title: 'Pricing', plans: [{ name: 'Solo', price: '$9/mo', features: ['1 seat', 'Unlimited exports'] }, { name: 'Team', price: '$29/mo', features: ['5 seats', 'Shared library', 'SSO'] }] },
    { type: 'testimonials', items: [{ quote: 'Cut our UI backlog in half.', author: 'Mai, Studio Nine' }, { quote: 'It just works </blockquote><script>alert(3)</script>', author: 'Hacker' }] },
    { type: 'faq', items: [{ q: 'Is there a free plan?', a: 'Yes, 20 exports a month.' }] },
    { type: 'founder_note', body: 'I built this after redrawing the same table 40 times.\n\nThanks for trying it.', author: 'Duy, founder' },
    { type: 'links', items: [{ label: 'Docs', url: 'https://pixelmint.example/docs' }, { label: 'Bad', url: 'javascript:alert(1)' }, { label: 'GitHub', url: 'https://github.com/pixelmint' }] },
    { type: 'call_to_action', label: 'Start free', url: 'https://pixelmint.example/signup', note: 'No card required.' },
  ],
};
pages['product'] = productPage(ctx('/p/pixelmint', 'Pixelmint'), product);
pages['product-published'] = productPage(ctx('/p/shipnote', 'Shipnote'), { ...product, name: 'Shipnote', status: 'published', previewVersion: null, blocks: [] });

pages['snapshot'] = snapshotPage(ctx('/s/daily/2026-11-08', 'Daily snapshot 2026-11-08'), {
  board: 'daily', date: '2026-11-08', cutoffAt: '2026-11-07T20:12:00.000Z', executedAt: '2026-11-07T20:12:04.512Z', rankingPolicyVersion: 'rank-v1',
  items: rows(15, 12).map((r, i) => ({
    rank: r.rank, slug: r.slug, name: r.name, rankUnits: r.activeRankUnits, ownerSuccessfulReferrals: r.ownerSuccessfulReferrals,
    validClicks: r.validClicks, validViews: r.validViews, visibilityState: i === 4 || i === 12 ? 'removed_from_publication' : 'visible', isSample: r.isSample,
  })),
  media: [{ kind: 'video', platform: null, status: 'mocked', url: null }, { kind: 'post', platform: 'x', status: 'mocked', url: 'https://x.example/post/1' }, { kind: 'post', platform: 'youtube', status: 'skipped: <b>no key</b>', url: 'javascript:alert(1)' }],
  cohort: [{ currency: 'USD', eligibleRevenueMinor: 241050, adsFundMinor: 192840, commissionMinor: 6000, operatorMinor: 42210 }, { currency: 'VND', eligibleRevenueMinor: 1250000, adsFundMinor: 1000000, commissionMinor: 0, operatorMinor: 250000 }],
  prevDate: '2026-11-07', nextDate: null,
});

pages['account'] = accountPage(ctx('/account', 'Account'), {
  viewer: { userId: 'u_1', displayName: 'Linh Tran', avatarUrl: 'http://127.0.0.1:8791/img/bip-mark.webp' },
  products: [
    { slug: 'pixelmint', name: 'Pixelmint', status: 'published', standings: [{ board: 'daily', rank: 8, activeRankUnits: 9900 }, { board: 'weekly', rank: null, activeRankUnits: 0 }, { board: 'monthly', rank: 2, activeRankUnits: 120000 }] },
    { slug: 'evil', name: '<i>Draft</i> thing', status: 'pending_review', standings: [{ board: 'daily', rank: 14, activeRankUnits: 0 }] },
  ],
  payments: [
    { createdAt: '2026-11-08T09:14:00Z', board: 'daily', productName: 'Pixelmint', currency: 'USD', amountMinor: 2500, provider: 'paypal', state: 'captured' },
    { createdAt: '2026-11-06T02:01:00Z', board: 'monthly', productName: 'Pixelmint', currency: 'VND', amountMinor: 250000, provider: 'sepay', state: 'settled' },
  ],
  referral: { code: 'LINH-7Q2', link: 'http://127.0.0.1:8791/r/LINH-7Q2', successful: 14, pending: 3 },
  wallet: {
    pending: [{ currency: 'USD', minor: 375 }], available: [{ currency: 'USD', minor: 1240 }, { currency: 'VND', minor: 62500 }],
    reservedForBid: [], reservedForPayout: [{ currency: 'USD', minor: 500 }], paid: [{ currency: 'USD', minor: 2000 }],
  },
  walletHistory: [
    { at: '2026-11-07T10:00:00Z', currency: 'USD', deltaMinor: 125, memo: 'Referral commission (5%)' },
    { at: '2026-11-05T10:00:00Z', currency: 'USD', deltaMinor: -500, memo: 'Reserved for payout' },
  ],
  payouts: [
    { requestedAt: '2026-10-28T08:00:00Z', currency: 'USD', requestedMinor: 2000, state: 'paid', transferReference: 'VCB-20261103-0012' },
    { requestedAt: '2026-11-05T10:00:00Z', currency: 'USD', requestedMinor: 500, state: 'payout_requested', transferReference: null },
  ],
  mcpUrl: 'http://127.0.0.1:8791/mcp',
});

const checkout: CheckoutView = {
  intentId: 'bi_01HZX', status: 'awaiting_payment', productName: 'Tidy <Inbox>', productSlug: 'tidy-inbox', board: 'daily',
  rankUnits: 2500, quoteCurrency: 'USD', quoteMinor: 2500, walletAppliedMinor: 1240, dueMinor: 1260, fxRate: null,
  quoteExpiresAt: new Date(NOW + 15 * 60e3).toISOString(), activeHours: 24, projectedRank: 2, providers: ['paypal'],
  paymentMode: 'simulated', isOwner: true, csrf: 'csrf"><script>alert(1)</script>', message: null,
};
pages['checkout'] = checkoutPage(ctx('/checkout/bi_01HZX', 'Checkout'), checkout);
pages['checkout-vnd'] = checkoutPage(ctx('/checkout/bi_02', 'Checkout'), { ...checkout, quoteCurrency: 'VND', quoteMinor: 650000, walletAppliedMinor: 0, dueMinor: 650000, fxRate: 26000, providers: ['sepay'] });
pages['checkout-wallet'] = checkoutPage(ctx('/checkout/bi_03', 'Checkout'), { ...checkout, walletAppliedMinor: 2500, dueMinor: 0, message: 'Your wallet covers this bid.' });
pages['checkout-guest'] = checkoutPage(ctx('/checkout/bi_04', 'Checkout', false), { ...checkout, isOwner: false });
pages['checkout-confirmed'] = checkoutPage(ctx('/checkout/bi_05', 'Checkout'), { ...checkout, status: 'confirmed', message: 'PayPal confirmed the payment.' });
pages['checkout-expired'] = checkoutPage(ctx('/checkout/bi_06', 'Checkout'), { ...checkout, status: 'expired' });
pages['login'] = loginPage(ctx('/login', 'Sign in', false), { next: '/checkout/bi_01HZX?x=1&y=2', error: 'GitHub sign-in was cancelled.' });
pages['authorize'] = authorizePage(ctx('/authorize', 'Connect an agent', false), {
  clientName: 'Claude <script>alert(1)</script>', scopes: ['products', 'quotes', 'checkouts', 'referrals', 'wallet'],
  startUrls: { github: '/auth/github/start?grant=abc', google: '/auth/google/start?grant=abc' },
});
pages['error-404'] = errorPage(ctx('/nope', 'Not found', false), 404, 'No product lives at /p/<nope>.');
pages['error-403'] = errorPage(ctx('/account', 'Forbidden', false), 403, 'Sign in as the owner to view this checkout.');
pages['error-500'] = errorPage(ctx('/daily', 'Error', false), 500, '');

// Escaping assertions: hostile fixture strings must never appear as live markup.
const failures: string[] = [];
for (const [name, htmlText] of Object.entries(pages)) {
  if (/<script>alert/i.test(htmlText)) failures.push(`${name}: unescaped <script>alert`);
  if (/<img src=x/i.test(htmlText)) failures.push(`${name}: unescaped <img src=x`);
  if (/(href|src)="\s*javascript:/i.test(htmlText)) failures.push(`${name}: javascript: URL in href/src`);
  if (/\son[a-z]+="/i.test(htmlText)) failures.push(`${name}: inline event handler attribute`);
  if (/<iframe/i.test(htmlText)) failures.push(`${name}: iframe`);
  writeFileSync(join(out, `${name}.html`), htmlText, 'utf8');
}
if (failures.length) {
  console.error('ESCAPING FAILURES\n' + failures.join('\n'));
  process.exit(1);
}
console.log(`rendered ${Object.keys(pages).length} pages to ${out}; escaping assertions passed`);
