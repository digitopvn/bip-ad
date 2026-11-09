import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { runLock } from '../src/domain/snapshot';
import { checkoutPage } from '../src/views/checkout';
import { cutoffAtOrBefore, ictDate } from '../src/lib/time';
import { bid, db, makeProduct, makeUser } from './helpers';

const BASE = 'https://bip.test';
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36' };

describe('public routes', () => {
  it('serve the board pages, product page and snapshot with D1 data', async () => {
    const u = await makeUser();
    const p = await makeProduct(u, 'Route Product');
    await bid(u, p, 'daily', 4200, Date.now() - 60_000);
    const slug = (await db().prepare('SELECT slug FROM products WHERE id = ?').bind(p).first<{ slug: string }>())!.slug;
    for (const path of ['/', '/daily', '/weekly', '/monthly', `/p/${slug}`]) {
      const r = await SELF.fetch(BASE + path, { headers: UA });
      expect(r.status, path).toBe(200);
      const html = await r.text();
      if (path !== '/weekly' && path !== '/monthly') expect(html, path).toContain('Route Product');
    }
    const cutoff = cutoffAtOrBefore(Date.now());
    await runLock(db(), BASE, cutoff, Date.now());
    const s = await SELF.fetch(`${BASE}/s/daily/${ictDate(cutoff)}`);
    expect(s.status).toBe(200);
    expect(await SELF.fetch(`${BASE}/s/daily/1999-01-01`).then(r => r.status)).toBe(404);
    const api = await SELF.fetch(`${BASE}/api/boards/daily`).then(r => r.json()) as { rows: { slug: string; activeRankUnits: number }[] };
    expect(api.rows.find(r => r.slug === slug)?.activeRankUnits).toBe(4200);
  });

  it('product page views and outbound clicks are measured once per visitor per day; bots are ignored', async () => {
    const u = await makeUser();
    const p = await makeProduct(u, 'Measured');
    const slug = (await db().prepare('SELECT slug FROM products WHERE id = ?').bind(p).first<{ slug: string }>())!.slug;
    await SELF.fetch(`${BASE}/p/${slug}`, { headers: { ...UA, 'cf-connecting-ip': '1.2.3.4' } });
    await SELF.fetch(`${BASE}/p/${slug}`, { headers: { ...UA, 'cf-connecting-ip': '1.2.3.4' } });
    await SELF.fetch(`${BASE}/p/${slug}`, { headers: { 'user-agent': 'Googlebot/2.1', 'cf-connecting-ip': '5.6.7.8' } });
    const go = await SELF.fetch(`${BASE}/go/${slug}`, { headers: { ...UA, 'cf-connecting-ip': '1.2.3.4' }, redirect: 'manual' });
    expect(go.status).toBe(302);
    expect(go.headers.get('location')).toBe('https://example.com');
    const n = await db().prepare('SELECT event_type, COUNT(*) AS n FROM measurement_events WHERE product_id = ? GROUP BY event_type ORDER BY event_type').bind(p).all();
    expect(n.results).toEqual([{ event_type: 'outbound_click', n: 1 }, { event_type: 'product_page_view', n: 1 }]);
  });

  it('A02: there is no web or REST endpoint that creates products', async () => {
    for (const [method, path] of [['POST', '/api/products'], ['POST', '/products'], ['PUT', '/api/products/x'], ['POST', '/p/new']] as const) {
      const r = await SELF.fetch(BASE + path, { method, body: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json' } });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });

  it('/account requires sign-in; /checkout of an unknown intent is 404; drafts are private', async () => {
    const a = await SELF.fetch(`${BASE}/account`, { redirect: 'manual' });
    expect(a.status).toBe(302);
    expect(a.headers.get('location')).toContain('/login');
    expect((await SELF.fetch(`${BASE}/checkout/bid_nope`)).status).toBe(404);
    const u = await makeUser();
    const { createProduct } = await import('../src/domain/products');
    const d = await createProduct(db(), u, { name: 'Secret Draft', tagline: 't', website_url: 'https://example.com' }, 'draft-key-1');
    expect((await SELF.fetch(`${BASE}/p/${d.slug}`)).status).toBe(404);
  });

  it('serves the legal pages with the site layout and links them from every footer', async () => {
    for (const [path, title] of [['/terms', 'Terms of Service'], ['/privacy', 'Privacy Policy'], ['/refunds', 'Refund Policy']] as const) {
      const r = await SELF.fetch(BASE + path);
      expect(r.status, path).toBe(200);
      const html = await r.text();
      expect(html, path).toContain(`<h1 class="h2" id="${path.slice(1)}-title">${title}</h1>`);
      expect(html, path).toContain('class="site-footer"');
      expect(html, path).toContain('does not replace advice from a lawyer');
    }
    const home = await SELF.fetch(`${BASE}/`).then(r => r.text());
    for (const href of ['/terms', '/privacy', '/refunds']) expect(home).toContain(`href="${href}"`);
  });

  it('the checkout page links to the Terms and the Refund Policy next to the all-pay notice', () => {
    const page = checkoutPage({ title: 'Checkout', path: '/checkout/bid_x', viewer: null, testMode: true, origin: BASE }, {
      intentId: 'bid_x', status: 'awaiting_payment', productName: 'P', productSlug: 'p', board: 'daily', rankUnits: 100, quoteCurrency: 'USD',
      quoteMinor: 100, walletAppliedMinor: 0, dueMinor: 100, fxRate: null, quoteExpiresAt: new Date().toISOString(), activeHours: 24,
      projectedRank: 1, providers: ['paypal'], paymentMode: 'simulated', isOwner: true, csrf: 'c', message: null,
    });
    const notice = page.slice(page.indexOf('class="all-pay"'));
    expect(notice.indexOf('href="/terms"')).toBeGreaterThan(0);
    expect(notice.indexOf('href="/refunds"')).toBeGreaterThan(0);
    expect(notice.indexOf('href="/refunds"')).toBeLessThan(notice.indexOf('class="pay-options"'));
  });

  it('referral links only set a cookie for real codes and never redirect off-site', async () => {
    const r = await SELF.fetch(`${BASE}/r/zzzzzzzz`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/');
    expect(r.headers.get('set-cookie')).toBeNull();
  });
});

describe('MCP endpoints', () => {
  it('/mcp requires an OAuth bearer token and advertises protected resource metadata', async () => {
    const r = await SELF.fetch(`${BASE}/mcp`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/Bearer/);
    const meta = await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    expect([200, 404]).toContain(meta.status);
    const as = await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`).then(x => x.json()) as { authorization_endpoint: string; registration_endpoint: string };
    expect(as.authorization_endpoint).toMatch(/\/authorize$/);
    expect(as.registration_endpoint).toMatch(/\/register$/);
  });

  it('/operator/mcp rejects missing or user credentials and lists operator tools with the operator token', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await SELF.fetch(`${BASE}/operator/mcp`, { method: 'POST', body, headers })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/operator/mcp`, { method: 'POST', body, headers: { ...headers, authorization: 'Bearer user-token' } })).status).toBe(401);
    const ok = await SELF.fetch(`${BASE}/operator/mcp`, { method: 'POST', body, headers: { ...headers, authorization: 'Bearer test-operator-token-0123456789abcdef0123' } });
    expect(ok.status).toBe(200);
    const j = await ok.json() as { result: { tools: { name: string }[] } };
    const names = j.result.tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['products.moderate', 'boards.freeze', 'payouts.prepare_batch', 'payouts.record_manual_transfer', 'finance.reconcile']));
  });
});
