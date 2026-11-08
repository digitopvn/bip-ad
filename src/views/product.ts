// Product page built from widget blocks. All widget content is untrusted: text is escaped,
// media and links are accepted only as absolute http(s) URLs, and no iframe or raw HTML is emitted.
import { boardPath, hueFor, icon, notice, sampleTag } from './components';
import { boardLabel, formatCount, formatRankUnits } from './format';
import { html, httpUrl, join, seg, type SafeHtml } from './html';
import { layout } from './layout';
import { renderMarkdown } from './markdown';
import type { LayoutContext, ProductPageView, WidgetBlock } from './types';

const UGC_REL = 'nofollow ugc noopener noreferrer';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function paragraphs(text: string): SafeHtml {
  return join(
    text
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => html`<p>${p}</p>`),
  );
}

function img(url: string, alt: string, cls = ''): SafeHtml | '' {
  const src = httpUrl(url);
  if (!src) return '';
  return html`<img${cls ? html` class="${cls}"` : ''} src="${src}" alt="${alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}

/** External link that only renders as an anchor for http(s) URLs. */
function extLink(url: string, label: SafeHtml | string, cls = ''): SafeHtml {
  const href = httpUrl(url);
  if (!href) return html`<span${cls ? html` class="${cls}"` : ''}>${label}</span>`;
  return html`<a${cls ? html` class="${cls}"` : ''} href="${href}" rel="${UGC_REL}">${label}</a>`;
}

function directVideo(url: string): boolean {
  try {
    return /\.(mp4|webm)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function blockTitle(title: string | undefined): SafeHtml | '' {
  return title ? html`<h2 class="w-title">${title}</h2>` : '';
}

function renderBlock(block: WidgetBlock): SafeHtml {
  switch (block.type) {
    case 'hero':
      return html`<section class="w w-hero"><div><h2 class="w-hero-title">${block.headline}</h2>${
        block.subheadline ? html`<p class="w-lede">${block.subheadline}</p>` : ''
      }</div>${block.image_url ? img(block.image_url, '', 'w-hero-img') : ''}</section>`;
    case 'gallery':
      return html`<section class="w w-gallery" aria-label="Gallery"><ul>${block.images.map((i) => {
        const tag = img(i.url, i.alt);
        return tag ? html`<li><figure>${tag}${i.alt ? html`<figcaption>${i.alt}</figcaption>` : ''}</figure></li>` : '';
      })}</ul></section>`;
    case 'video': {
      const src = httpUrl(block.url);
      if (!src) return html``;
      const title = block.title ?? 'Product video';
      if (directVideo(src)) {
        return html`<section class="w w-video"><figure><video controls preload="metadata" playsinline src="${src}"></video><figcaption>${title}</figcaption></figure></section>`;
      }
      return html`<section class="w w-video"><a class="w-linkcard" href="${src}" rel="${UGC_REL}"><span class="w-linkcard-k">Video</span><strong>${title}</strong><span>Watch on ${hostOf(src)} ${icon('out')}</span></a></section>`;
    }
    case 'feature_grid':
      return html`<section class="w">${blockTitle(block.title)}<ul class="w-features">${block.features.map(
        (f) => html`<li><h3>${f.title}</h3><p>${f.body}</p></li>`,
      )}</ul></section>`;
    case 'rich_text':
      return html`<section class="w prose">${renderMarkdown(block.markdown)}</section>`;
    case 'call_to_action':
      return html`<section class="w w-cta"><p>${extLink(block.url, html`${block.label} ${icon('out')}`, 'btn btn-primary')}</p>${
        block.note ? html`<p class="w-note">${block.note}</p>` : ''
      }</section>`;
    case 'pricing':
      return html`<section class="w">${blockTitle(block.title ?? 'Pricing')}<ul class="w-pricing">${block.plans.map(
        (p) =>
          html`<li><h3>${p.name}</h3><p class="w-price">${p.price}</p><ul class="list-check yes">${p.features.map(
            (f) => html`<li>${icon('check')}<span>${f}</span></li>`,
          )}</ul></li>`,
      )}</ul></section>`;
    case 'testimonials':
      return html`<section class="w"><h2 class="w-title">What people say</h2><ul class="w-quotes">${block.items.map(
        (t) => html`<li><figure><blockquote><p>${t.quote}</p></blockquote><figcaption>${t.author}</figcaption></figure></li>`,
      )}</ul></section>`;
    case 'faq':
      return html`<section class="w"><h2 class="w-title">Questions</h2><div class="faq">${block.items.map(
        (i) => html`<details><summary>${i.q}${icon('plus')}</summary><p>${i.a}</p></details>`,
      )}</div></section>`;
    case 'founder_note':
      return html`<section class="w w-founder"><h2 class="w-title">A note from the founder</h2><blockquote>${paragraphs(block.body)}</blockquote><p class="w-author">${block.author}</p></section>`;
    case 'links':
      return html`<section class="w"><h2 class="w-title">Links</h2><ul class="w-links">${block.items.map(
        (l) => html`<li>${extLink(l.url, html`<span>${l.label}</span>${httpUrl(l.url) ? html`<small>${hostOf(l.url)}</small>` : ''}`)}</li>`,
      )}</ul></section>`;
    case 'metrics':
      return html`<section class="w"><dl class="w-metrics">${block.items.map(
        (m) => html`<div><dt>${m.label}</dt><dd>${m.value}</dd></div>`,
      )}</dl></section>`;
    default: {
      const unknown: never = block;
      void unknown;
      return html``;
    }
  }
}

const STATUS_COPY: Record<Exclude<ProductPageView['status'], 'published'>, { kind: 'info' | 'warn' | 'error'; text: string }> = {
  draft: { kind: 'info', text: 'Draft: this page is not public yet. Ask your agent to publish it for review.' },
  pending_review: { kind: 'info', text: 'Pending review: moderation is checking this page before it goes live.' },
  rejected: { kind: 'error', text: 'Rejected by moderation. Your agent can fix the page and submit it again.' },
  suspended: { kind: 'error', text: 'Suspended: this product is hidden from the boards while moderation reviews it.' },
};

function safeOutbound(path: string, slug: string): string {
  return /^\/(?![/\\])[^\s]*$/.test(path) ? path : `/go/${seg(slug)}`;
}

export function productPage(ctx: LayoutContext, view: ProductPageView): string {
  const host = hostOf(view.websiteUrl);
  const outbound = safeOutbound(view.outboundPath, view.slug);
  const banners: SafeHtml[] = [];
  if (view.previewVersion !== null) {
    banners.push(
      notice('warn', html`<strong>Preview of page version ${view.previewVersion}.</strong> Only you can see this until moderation approves it.`),
    );
  }
  if (view.status !== 'published') {
    const s = STATUS_COPY[view.status];
    banners.push(notice(s.kind, s.text));
  }
  const standings = view.standings.map(
    (s) =>
      html`<li><a href="${boardPath(s.board)}"><span class="st-board">${boardLabel(s.board)}</span><span class="st-rank">${
        s.rank === null ? 'Not ranked' : `#${s.rank}`
      }</span><span class="st-bid">${s.activeRankUnits > 0 ? `${formatRankUnits(s.activeRankUnits)} active` : 'Free listing'}</span></a></li>`,
  );

  const body = html`<article class="product" style="--h:${hueFor(view.slug)}">
  <div class="wrap">
    ${banners.length ? html`<div class="banners">${banners}</div>` : ''}
    <header class="product-head">
      <span class="cover product-cover" aria-hidden="true"><span>${Array.from(view.name.trim())[0]?.toUpperCase() ?? '?'}</span></span>
      <div class="product-intro">
        <h1>${view.name}${sampleTag(view.isSample)}</h1>
        <p class="lede">${view.tagline}</p>
        <div class="cta-row">
          <a class="btn btn-primary" href="${outbound}" rel="nofollow sponsored noopener">Visit ${host || 'website'} ${icon('out')}</a>
          <a class="btn btn-ghost" href="/#board">Back to the board</a>
        </div>
      </div>
      <aside class="panel-box standings" aria-labelledby="standings-title">
        <h2 id="standings-title">Standings now</h2>
        <ul>${standings}</ul>
        <p class="st-note">${formatCount(view.ownerSuccessfulReferrals)} successful owner referrals. They only break ties between equal bids.</p>
      </aside>
    </header>
    <div class="widgets">
      ${view.blocks.length ? view.blocks.map(renderBlock) : html`<p class="empty">This product has not added any page content yet.</p>`}
    </div>
    <p class="product-legal">Rank on bip.ad is paid placement and is not a rating of quality.${
      view.pageVersion !== null ? ` Page version ${view.pageVersion}.` : ''
    }</p>
  </div>
</article>`;
  return layout(ctx, body.toString());
}
