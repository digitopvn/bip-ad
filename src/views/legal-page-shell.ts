// Shared shell for the public legal pages (/terms, /privacy, /refunds).
//
// GO-LIVE CHECKLIST: the policy text in legal-*-page.ts is the operator's own draft. The owner must
// have Terms, Privacy and Refunds reviewed by a qualified lawyer before live payments are enabled,
// and must update LEGAL_EFFECTIVE_DATE whenever the text changes materially.
import { notice } from './components';
import { html, type SafeHtml } from './html';
import { layout } from './layout';
import type { LayoutContext } from './types';

export const LEGAL_OPERATOR = 'Digitop';
export const LEGAL_CONTACT_EMAIL = 'hello@bip.ad';
export const LEGAL_EFFECTIVE_DATE = '2026-11-09';

/** The three policy pages, in footer order. */
export const LEGAL_PAGES = [
  { href: '/terms', label: 'Terms of Service' },
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/refunds', label: 'Refund Policy' },
] as const;

export const contactLink = (): SafeHtml => html`<a href="mailto:${LEGAL_CONTACT_EMAIL}">${LEGAL_CONTACT_EMAIL}</a>`;

/** Renders a policy page: kicker, title, effective date, the not-legal-advice note, then the prose body. */
export function legalPage(ctx: LayoutContext, opts: { id: string; title: string; lede: string; body: SafeHtml }): string {
  const others = LEGAL_PAGES.filter((p) => p.href !== ctx.path);
  const body = html`<section class="section-tight legal" aria-labelledby="${opts.id}">
  <div class="wrap narrow">
    <p class="kicker">Policies</p>
    <h1 class="h2" id="${opts.id}">${opts.title}</h1>
    <p class="section-lede">${opts.lede}</p>
    <p class="muted">Effective ${LEGAL_EFFECTIVE_DATE}. Operated by ${LEGAL_OPERATOR}. Contact: ${contactLink()}.</p>
    ${notice(
      'info',
      html`<strong>Please note:</strong> this is the operator's own policy for bip.ad. It is not legal advice and does not replace advice from a lawyer.`,
      null,
    )}
    <div class="prose">${opts.body}</div>
    <p class="muted">See also: ${others.map((p, i) => html`${i ? ' · ' : ''}<a href="${p.href}">${p.label}</a>`)}.</p>
  </div>
</section>`;
  return layout(ctx, body.toString());
}
