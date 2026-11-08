// Page shell: head, header, test-mode banner, footer, ribbon canvas and the deferred client script.
import { ICON_SPRITE, icon } from './components';
import { html, raw, type SafeHtml } from './html';
import type { LayoutContext } from './types';

const SITE_NAME = 'bip.ad';
const DEFAULT_DESCRIPTION =
  'Builders list products through their AI agents and bid openly for a seat. Every night at 3:12 ICT the board locks and the Top 10 becomes a video on X, Facebook and YouTube.';

interface NavLink {
  href: string;
  label: string;
  /** Path prefix that marks this link as the current page. */
  match?: string;
}

function navLinks(ctx: LayoutContext): NavLink[] {
  return [
    { href: '/daily', label: 'Daily', match: '/daily' },
    { href: '/weekly', label: 'Weekly', match: '/weekly' },
    { href: '/monthly', label: 'Monthly', match: '/monthly' },
    { href: '/#agents', label: 'For agents' },
    ctx.viewer ? { href: '/account', label: 'Account', match: '/account' } : { href: '/login', label: 'Sign in', match: '/login' },
  ];
}

function isCurrent(path: string, link: NavLink): boolean {
  if (!link.match) return false;
  return path === link.match || path.startsWith(`${link.match}/`);
}

function renderNav(ctx: LayoutContext): SafeHtml {
  return html`${navLinks(ctx).map(
    (l) => html`<a href="${l.href}"${isCurrent(ctx.path, l) ? raw(' aria-current="page"') : ''}>${l.label}</a>`,
  )}`;
}

function absolute(origin: string, path: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

const brand = (): SafeHtml =>
  raw(
    '<img class="brand-mark" src="/img/bip-mark.webp" alt="" width="39" height="36">' +
      '<img class="brand-word" src="/img/bip-word-navy.webp" alt="bip.ad" width="65" height="22">',
  );

export function layout(ctx: LayoutContext, body: string, opts: { boardDataJson?: string } = {}): string {
  const description = ctx.description ?? DEFAULT_DESCRIPTION;
  const title = ctx.title.includes(SITE_NAME) ? ctx.title : `${ctx.title} · ${SITE_NAME}`;
  const canonical = absolute(ctx.origin, ctx.path);
  const ogImage = absolute(ctx.origin, '/img/bip-ad-logo.png');
  // JSON is embedded in a non-executing script element; escape "<" so "</script>" cannot appear.
  const boardData = opts.boardDataJson
    ? raw(`<script type="application/json" id="board-data">${opts.boardDataJson.replace(/</g, '\\u003c')}</script>`)
    : '';

  const page = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="theme-color" content="#f8f7fc">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/img/bip-mark.webp" type="image/webp">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${ogImage}">
<meta name="twitter:card" content="summary">
<meta name="twitter:image" content="${ogImage}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,500..800&amp;family=Instrument+Sans:wght@400..700&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
<script src="/app.js" defer></script>
</head>
<body>
${ICON_SPRITE}
<canvas class="bg-canvas" data-bg aria-hidden="true"></canvas>
<a class="skip" href="#main">Skip to content</a>
<div class="page">
${ctx.testMode ? html`<p class="test-banner" role="note"><strong>Test mode:</strong> payments are simulated, no real money moves.</p>` : ''}
<header class="site-header">
  <div class="wrap header-row">
    <a class="brand" href="/" aria-label="bip.ad home">${brand()}</a>
    <nav class="nav" aria-label="Primary">${renderNav(ctx)}</nav>
    <div class="header-actions">
      <a class="btn btn-primary btn-sm" href="/#agents"><span>List<span class="btn-label-long"> your product</span></span></a>
      <button class="menu-btn" type="button" popovertarget="mobile-menu" aria-label="Open menu">${icon('menu')}</button>
    </div>
  </div>
</header>
<nav id="mobile-menu" class="mobile-menu" popover aria-label="Mobile">${renderNav(ctx)}</nav>
<main id="main" tabindex="-1">
${raw(body)}
</main>
<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <div class="footer-brand">
        <a class="brand" href="/" aria-label="bip.ad home">${brand()}</a>
        <p>Build in public. Bid to win. A launch board where rank is bought openly and recorded every night at 3:12 ICT.</p>
      </div>
      <div><h2>Boards</h2><ul><li><a href="/daily">Daily</a></li><li><a href="/weekly">Weekly</a></li><li><a href="/monthly">Monthly</a></li></ul></div>
      <div><h2>Product</h2><ul><li><a href="/#why">Why 3:12</a></li><li><a href="/#agents">For agents</a></li><li><a href="/#money">Transparency</a></li></ul></div>
      <div><h2>Policies</h2><ul><li><a href="/#rules">Ranking rules</a></li><li><a href="/#faq">Refund policy</a></li><li><a href="/#faq">Payments</a></li></ul></div>
    </div>
    <div class="footer-legal"><span>Rank on bip.ad is paid placement and is not a rating of quality.</span><span>© 2026 bip.ad</span></div>
  </div>
</footer>
</div>
${boardData}
</body>
</html>`;
  return page.toString();
}
