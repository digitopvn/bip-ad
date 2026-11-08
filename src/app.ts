// Web routes (Hono). Read-only for products: there is deliberately no route that creates or edits
// a product; that only happens over the authenticated MCP endpoint (brief decision 2, A02).
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { authorizeUrl, exchange, type UpstreamProvider } from './auth/upstream';
import { clearReferralCookie, createSession, destroySession, getSession, getUser, readReferralCookie, setReferralCookie, upsertUser } from './auth/session';
import { beginCheckout, getIntent, PROVIDER_CURRENCY, projectedRank, settle, type Provider } from './domain/bidding';
import { BOARD_HOURS, BOARDS, config, isBoard, type Board } from './domain/config';
import { DomainError, isConstraintError } from './domain/errors';
import { isLikelyBot, recordEvent, visitorHash } from './domain/measurement';
import { getProductBySlug, pageBlocks } from './domain/products';
import { attributeSignup, isReferralCodeShape } from './domain/referrals';
import type { Env } from './env';
import { randomToken } from './lib/ids';
import { safeEqual } from './lib/crypto';
import { cutoffForIctDate, isValidDate } from './lib/time';
import { serveMcp } from './mcp/common';
import { operatorMcpServer } from './mcp/operator-server';
import { captureOrder, verifyWebhook } from './payments/paypal';
import { normalizePayPal, normalizeSePay, processEvent, simulatePayment } from './payments/process';
import { checkoutForm, verifyIpn } from './payments/sepay';
import { createProviderCheckout } from './payments/checkout';
import { accountView, boardView, checkoutView, homeView, layoutCtx, productView, snapshotView } from './routes/view-data';
import { accountPage } from './views/account';
import { authorizePage } from './views/authorize';
import { boardPage } from './views/board';
import { checkoutPage } from './views/checkout';
import { errorPage } from './views/error';
import { homePage } from './views/home';
import { escapeHtml } from './views/html';
import { loginPage } from './views/login';
import { productPage } from './views/product';
import { snapshotPage } from './views/snapshot';

type C = Context<{ Bindings: Env }>;
export const app = new Hono<{ Bindings: Env }>();

app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    imgSrc: ["'self'", 'https:', 'data:'],
    mediaSrc: ['https:'],
    connectSrc: ["'self'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'", 'https://pay.sepay.vn', 'https://pay-sandbox.sepay.vn'],
  },
  crossOriginEmbedderPolicy: false,
}));

const safeNext = (n: string | undefined) => (n && n.startsWith('/') && !n.startsWith('//') && !n.includes('\\') ? n : '/account');

async function viewer(c: C) {
  const s = await getSession(c);
  if (!s) return { session: null, user: null };
  const user = await getUser(c.env.DB, s.userId);
  return { session: user && user.status === 'active' ? s : null, user: user && user.status === 'active' ? user : null };
}

async function page(c: C, title: string, render: (ctx: ReturnType<typeof layoutCtx>) => string, status = 200, description?: string) {
  const { user } = await viewer(c);
  const ctx = layoutCtx(c.env, new URL(c.req.url).pathname, user, title, description);
  return c.html(render(ctx), status as 200);
}

const notFoundPage = (c: C, msg = 'This page does not exist.') => page(c, 'Not found', ctx => errorPage(ctx, 404, msg), 404);

// ---------- Public pages ----------

app.get('/', async c => {
  const v = await homeView(c.env);
  return page(c, 'bip.ad — the launch board that locks at 3:12', ctx => homePage(ctx, v), 200, 'Builders list products through their AI agents and bid openly for a seat. Every night at 03:12 ICT the Top 10 is locked.');
});

for (const b of BOARDS) {
  app.get(`/${b}`, async c => {
    const { view, lastSnapshotDate } = await boardView(c.env, b);
    return page(c, `${b[0].toUpperCase()}${b.slice(1)} board — bip.ad`, ctx => boardPage(ctx, view, lastSnapshotDate));
  });
}

app.get('/p/:slug', async c => {
  const p = await getProductBySlug(c.env.DB, c.req.param('slug'));
  if (!p) return notFoundPage(c, 'No product with that address.');
  const { user } = await viewer(c);
  const isOwner = !!user && user.id === p.owner_id;
  const preview = Number(c.req.query('preview')) || null;
  if ((p.status !== 'published' || preview) && !isOwner) return notFoundPage(c, 'No product with that address.');
  if (!isOwner && p.status === 'published') await measure(c, p.id, c.req.query('src') === 'card' ? ['product_page_view', 'product_card_click'] : ['product_page_view']);
  const v = await productView(c.env, p, preview);
  return page(c, `${p.name} — bip.ad`, ctx => productPage(ctx, v), 200, p.tagline);
});

app.get('/go/:slug', async c => {
  const p = await getProductBySlug(c.env.DB, c.req.param('slug'));
  if (!p || p.status !== 'published') return notFoundPage(c);
  const { user } = await viewer(c);
  if (!user || user.id !== p.owner_id) await measure(c, p.id, ['outbound_click']);
  // Redirect target is the stored product URL, never a request parameter: no open redirect.
  return c.redirect(p.website_url, 302);
});

app.get('/s/:board/:date', async c => {
  const board = c.req.param('board');
  const date = c.req.param('date').replace(/\.json$/, '');
  if (!isBoard(board) || !isValidDate(date)) return notFoundPage(c);
  const v = await snapshotView(c.env, board, date);
  if (!v) return notFoundPage(c, 'No snapshot was locked for that board and date.');
  if (c.req.param('date').endsWith('.json')) return c.json(v);
  return page(c, `${board} snapshot ${date} — bip.ad`, ctx => snapshotPage(ctx, v));
});

app.get('/r/:code', async c => {
  const code = c.req.param('code').toLowerCase();
  if (isReferralCodeShape(code)) {
    const exists = await c.env.DB.prepare('SELECT 1 FROM referral_codes WHERE code = ? AND status = \'active\'').bind(code).first();
    if (exists) await setReferralCookie(c, code);
  }
  return c.redirect('/', 302);
});

// ---------- Account ----------

const accountHandler = async (c: C) => {
  const { user } = await viewer(c);
  if (!user) return c.redirect(`/login?next=${encodeURIComponent(new URL(c.req.url).pathname)}`, 302);
  const v = await accountView(c.env, user);
  return page(c, 'Your account — bip.ad', ctx => accountPage(ctx, v));
};
app.get('/account', accountHandler);
app.get('/account/referrals', accountHandler);
app.get('/account/wallet', accountHandler);
app.get('/account/payouts', accountHandler);

// ---------- Checkout (human approval step) ----------

app.get('/checkout/:id', async c => {
  const intent = await getIntent(c.env.DB, c.req.param('id'));
  if (!intent) return notFoundPage(c, 'No checkout with that id.');
  const { session, user } = await viewer(c);
  const cfg = config(c.env);
  // SePay sandbox/live: hand the browser a signed auto-submitting form.
  if (c.req.query('go') === 'sepay' && user?.id === intent.owner_id && cfg.paymentMode !== 'simulated' && intent.provider === 'sepay' && intent.status === 'awaiting_payment') {
    const f = await checkoutForm(c.env, intent.id, intent.quote_minor - intent.wallet_applied_minor, cfg.origin);
    const inputs = Object.entries(f.fields).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
    return c.html(`<!doctype html><meta charset="utf-8"><title>Redirecting to SePay</title><form id="f" method="post" action="${escapeHtml(f.action)}">${inputs}<button>Continue to SePay</button></form><script src="/sepay-submit.js"></script>`);
  }
  const msg = { success: 'Payment submitted. Your rank changes as soon as the provider confirms it.', error: 'The payment did not go through.', cancel: 'Payment cancelled.', paid: 'Payment confirmed. Your bid is live.' }[c.req.query('r') ?? ''] ?? null;
  const v = await checkoutView(c.env, intent, user?.id === intent.owner_id, session?.csrf ?? '', msg);
  return page(c, 'Checkout — bip.ad', ctx => checkoutPage(ctx, v));
});

app.post('/checkout/:id/pay', async c => {
  const id = c.req.param('id');
  const { session, user } = await viewer(c);
  const form = await c.req.parseBody();
  if (!session || !user || typeof form.csrf !== 'string' || !safeEqual(form.csrf, session.csrf)) return page(c, 'Forbidden', ctx => errorPage(ctx, 403, 'Your session expired. Sign in again and retry.'), 403);
  // The all-pay acknowledgement checkbox is required on every pay form.
  if (form.all_pay_ack !== '1') return c.redirect(`/checkout/${id}?r=error`, 303);
  const method = String(form.method);
  const cfg = config(c.env);
  const intent = await getIntent(c.env.DB, id);
  if (!intent || intent.owner_id !== user.id) return page(c, 'Forbidden', ctx => errorPage(ctx, 403, 'Only the product owner can pay this checkout.'), 403);
  try {
    if (method === 'wallet') {
      const r = await beginCheckout(c.env.DB, cfg, user.id, id, 'wallet');
      if (r.dueMinor !== 0) return c.redirect(`/checkout/${id}?r=error`, 303);
      const s = await settle(c.env.DB, cfg, { intentId: id, provider: 'wallet', providerPaymentId: `wallet_${id}`, currency: intent.quote_currency, cashMinor: 0, confirmedAtMs: Date.now() });
      return c.redirect(`/checkout/${id}?r=${s.status === 'rejected' ? 'error' : 'paid'}`, 303);
    }
    if (method !== 'paypal' && method !== 'sepay') return c.redirect(`/checkout/${id}?r=error`, 303);
    const provider = method as Provider;
    if (PROVIDER_CURRENCY[provider] !== intent.quote_currency) return c.redirect(`/checkout/${id}?r=error`, 303);
    const r = await beginCheckout(c.env.DB, cfg, user.id, id, provider);
    if (cfg.paymentMode === 'simulated') {
      const s = await simulatePayment(c.env.DB, cfg, id, provider);
      return c.redirect(`/checkout/${id}?r=${s.status === 'settled' || s.status === 'duplicate' ? 'paid' : 'error'}`, 303);
    }
    const out = await createProviderCheckout(c.env, cfg, r.intent, provider);
    if (provider === 'sepay') return c.redirect(`/checkout/${id}?go=sepay`, 303);
    return c.redirect(out.redirectUrl ?? `/checkout/${id}?r=error`, 303);
  } catch (e) {
    if (e instanceof DomainError) return c.redirect(`/checkout/${id}?r=error`, 303);
    throw e;
  }
});

app.get('/checkout/:id/paypal-return', async c => {
  const id = c.req.param('id');
  const cfg = config(c.env);
  const intent = await getIntent(c.env.DB, id);
  const token = c.req.query('token');
  if (!intent || cfg.paymentMode === 'simulated' || !token || token !== intent.provider_order_id) return c.redirect(`/checkout/${id}?r=error`, 303);
  // The redirect alone proves nothing (A06); capture server-to-server and settle from PayPal's answer.
  const cap = await captureOrder(c.env, token);
  if (cap.capture?.status === 'COMPLETED' && cap.capture.custom_id === id) {
    await processEvent(c.env.DB, cfg, normalizePayPal({ id: `capture:${cap.capture.id}`, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: cap.capture.id, status: 'COMPLETED', custom_id: id, amount: cap.capture.amount } }));
    return c.redirect(`/checkout/${id}?r=paid`, 303);
  }
  return c.redirect(`/checkout/${id}?r=success`, 303);
});

// ---------- Sign-in ----------

app.get('/login', c => page(c, 'Sign in — bip.ad', ctx => loginPage(ctx, { next: safeNext(c.req.query('next')), error: c.req.query('error') ? 'Sign-in failed. Please try again.' : undefined })));

app.post('/logout', async c => {
  await destroySession(c);
  return c.redirect('/', 303);
});

app.get('/auth/:provider/start', async c => {
  const provider = c.req.param('provider');
  if (provider !== 'github' && provider !== 'google') return notFoundPage(c);
  const state = randomToken(24);
  const reqKey = c.req.query('req');
  await c.env.OAUTH_KV.put(`oauthstate:${state}`, JSON.stringify({ next: safeNext(c.req.query('next')), mcpReq: reqKey && /^[A-Za-z0-9_-]{20,64}$/.test(reqKey) ? reqKey : null }), { expirationTtl: 600 });
  setCookie(c, 'bip_oauth_state', state, { path: '/auth', httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Lax', maxAge: 600 });
  return c.redirect(authorizeUrl(c.env, config(c.env).origin, provider, state), 302);
});

app.get('/auth/:provider/callback', async c => {
  const provider = c.req.param('provider') as UpstreamProvider;
  if (provider !== 'github' && provider !== 'google') return notFoundPage(c);
  const state = c.req.query('state') ?? '';
  const code = c.req.query('code');
  const cookieState = getCookie(c, 'bip_oauth_state');
  deleteCookie(c, 'bip_oauth_state', { path: '/auth' });
  const stored = state ? await c.env.OAUTH_KV.get<{ next: string; mcpReq: string | null }>(`oauthstate:${state}`, 'json') : null;
  if (!code || !stored || !cookieState || !safeEqual(cookieState, state)) return c.redirect('/login?error=state', 302);
  await c.env.OAUTH_KV.delete(`oauthstate:${state}`);
  let ident;
  try {
    ident = await exchange(c.env, config(c.env).origin, provider, code);
  } catch (e) {
    console.error('oauth exchange failed', e);
    return c.redirect('/login?error=exchange', 302);
  }
  const { user, created } = await upsertUser(c.env.DB, ident);
  if (user.status !== 'active') return page(c, 'Account suspended', ctx => errorPage(ctx, 403, 'This account is suspended.'), 403);
  if (created) {
    const ref = await readReferralCookie(c);
    if (ref) await attributeSignup(c.env.DB, config(c.env), user.id, ref.code, ref.clickedAtMs);
  }
  clearReferralCookie(c);
  await createSession(c, user.id);
  if (stored.mcpReq) {
    const reqInfo = await c.env.OAUTH_KV.get(`mcpreq:${stored.mcpReq}`, 'json');
    if (!reqInfo) return c.redirect('/login?error=expired', 302);
    await c.env.OAUTH_KV.delete(`mcpreq:${stored.mcpReq}`);
    const info = reqInfo as Parameters<Env['OAUTH_PROVIDER']['completeAuthorization']>[0]['request'];
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: info, userId: user.id, metadata: { label: user.display_name }, scope: info.scope, props: { userId: user.id },
    });
    return c.redirect(redirectTo, 302);
  }
  return c.redirect(stored.next, 302);
});

// MCP OAuth consent: the client is identified, the user signs in upstream, then the grant is completed.
app.get('/authorize', async c => {
  let info;
  try {
    info = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch {
    return page(c, 'Invalid request', ctx => errorPage(ctx, 400, 'The authorization request is invalid.'), 400);
  }
  const client = await c.env.OAUTH_PROVIDER.lookupClient(info.clientId);
  if (!client) return page(c, 'Unknown client', ctx => errorPage(ctx, 400, 'Unknown OAuth client.'), 400);
  const key = randomToken(24);
  await c.env.OAUTH_KV.put(`mcpreq:${key}`, JSON.stringify(info), { expirationTtl: 600 });
  return page(c, 'Connect your agent — bip.ad', ctx => authorizePage(ctx, {
    clientName: client.clientName || client.clientId,
    scopes: info.scope,
    startUrls: { github: `/auth/github/start?req=${key}`, google: `/auth/google/start?req=${key}` },
  }));
});

// ---------- JSON API (read-only), measurement, webhooks ----------

app.get('/api/boards/:board', async c => {
  const board = c.req.param('board');
  if (!isBoard(board)) return c.json({ error: 'unknown board' }, 404);
  const { view } = await boardView(c.env, board);
  return c.json(view, 200, { 'cache-control': 'no-store' });
});

app.post('/api/events', async c => {
  let body: { type?: string; productId?: string };
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.body(null, 204);
  }
  if (body.type !== 'product_card_impression' || typeof body.productId !== 'string' || body.productId.length > 64) return c.body(null, 204);
  const p = await c.env.DB.prepare(`SELECT id, owner_id FROM products WHERE id = ? AND status = 'published'`).bind(body.productId).first<{ id: string; owner_id: string }>();
  const { user } = await viewer(c);
  if (p && (!user || user.id !== p.owner_id)) await measure(c, p.id, ['product_card_impression']);
  return c.body(null, 204);
});

async function measure(c: C, productId: string, types: ('product_card_impression' | 'product_card_click' | 'product_page_view' | 'outbound_click')[]) {
  const ua = c.req.header('user-agent') ?? '';
  if (isLikelyBot(ua)) return;
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const now = Date.now();
  const visitor = await visitorHash(c.env.SESSION_SECRET, ip, ua, now);
  for (const type of types) await recordEvent(c.env.DB, { productId, type, visitor, source: 'web', nowMs: now }).catch(e => console.error('measure failed', e));
}

app.post('/api/webhooks/paypal', async c => {
  const raw = await c.req.text();
  const cfg = config(c.env);
  const event = cfg.paymentMode === 'simulated' ? null : await verifyWebhook(c.env, c.req.raw.headers, raw).catch(() => null);
  if (!event) return c.json({ error: 'signature verification failed' }, 401);
  const r = await processEvent(c.env.DB, cfg, normalizePayPal(event));
  return c.json({ ok: true, status: r.status });
});

app.post('/api/webhooks/sepay', async c => {
  const raw = await c.req.text();
  const cfg = config(c.env);
  const ipn = cfg.paymentMode === 'simulated' ? null : verifyIpn(c.env, c.req.raw.headers, raw);
  if (!ipn) return c.json({ success: false }, 401);
  const r = await processEvent(c.env.DB, cfg, normalizeSePay(ipn));
  return c.json({ success: true, status: r.status });
});

// ---------- Operator MCP (separate identity) ----------

app.all('/operator/mcp', async c => {
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!c.env.OPERATOR_TOKEN || c.env.OPERATOR_TOKEN.length < 32 || !token || !safeEqual(token, c.env.OPERATOR_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer realm="bip-ad-operator"' });
  }
  return serveMcp(operatorMcpServer(c.env), c.req.raw);
});

app.get('/healthz', c => c.json({ ok: true }));

app.notFound(c => notFoundPage(c));
app.onError((err, c) => {
  console.error('unhandled', err);
  if (isConstraintError(err)) return c.text('Conflict', 409);
  return c.html(errorPage(layoutCtx(c.env, new URL(c.req.url).pathname, null, 'Error'), 500, 'Something went wrong on our side.'), 500);
});

